/**
 * dsh-reasoning-guard — 思考咏唱护栏。
 *
 * 解决问题：模型在长任务、反复失败时，reasoning 正文会退化成「好。/执行。/写。/GO。」
 * 这类行动宣告的复读机；dsh 的"思考"区以 white-space: pre-wrap 原样渲染每一段，
 * 于是用户看到一屏接一屏的重复短句。
 *
 * 本插件在会话事件流上统计该现象，越线后告警，并按配置在 agent idle 后压缩、
 * 暂停并恢复 goal，或取消当前 turn；可选地在下一步注入收敛提醒。
 *
 * 零外部静态依赖：只 import node: 内置模块与同目录 chant.js，缺失 @deepseek-ai/dsh-llm
 * 时自动降级，不阻断加载。
 */

import { randomUUID } from 'node:crypto';
import {
  analyzeReasoningText,
  checkBudget,
  createReasoningAnalyzer,
  createGuardState,
  evaluateBlock,
  previewBlock,
  recordVerdict,
  resetDetection,
  resolveConfig,
} from './chant.js';

export const name = 'reasoning-guard';

/** 可选服务通过 ctx.get 读取；preset 内的隔离服务由 agentPresets.serviceFor 定址。 */
export const inject = ['agents', 'tools'];

const MAX_AGENTS = 256;

/** 取 reasoning 块正文，兼容 content 里混排的 text / tool-call 块。 */
function reasoningOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') out += block.text + '\n';
  }
  return out;
}

/** 构造注入用的提醒消息；逐级降级，任何一步失败都返回 null 而不是抛出。 */
let factoryPromise;
async function buildReminder(text) {
  const content = [{ type: 'text', text }];
  if (factoryPromise === undefined) {
    factoryPromise = import('@deepseek-ai/dsh-llm')
      .then((mod) => (typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null))
      .catch(() => null);
  }
  const factory = await factoryPromise;
  if (typeof factory === 'function') {
    try {
      return factory({ content, source: { kind: 'user' } });
    } catch {
      // 落到手工构造
    }
  }
  try {
    return { role: 'user', content, source: { kind: 'user' }, id: randomUUID() };
  } catch {
    return null;
  }
}

function renderReport(rows, cfg, compactionAvailable) {
  const lines = ['dsh-reasoning-guard 状态', ''];
  lines.push(
    `阈值: 单块 ${cfg.perBlockLimit} 句 | ${cfg.windowBlocks} 块累计 ${cfg.windowLimit} 句 | 单 turn ${cfg.turnLimit} 句 | 预警档 ${cfg.elevatedBlockLimit} 句`
  );
  lines.push(`判定: 短句占比 ≥ ${Math.round(cfg.minChantRatio * 100)}% 或单块连续 ${cfg.perBlockLimit} 句 | 同一句连续 ${cfg.repeatedRunLimit} 次`);
  lines.push(
    `预算: 单 turn ${cfg.maxStepsPerTurn} 步 | ${cfg.maxTurnMinutes} 分钟（0 表示禁用）`
  );
  const compactState = cfg.autoCompact
    ? (compactionAvailable === null ? '自动压缩开（等待 agent）'
      : compactionAvailable ? '自动压缩开' : '自动压缩开但服务不可用')
    : '自动压缩关';
  lines.push(
    `动作: ${cfg.action}${cfg.intervene ? ' + 注入收敛提醒' : ''} | ${compactState} | 冷却 ${Math.round(cfg.cooldownMs / 1000)}s`
  );
  lines.push('');
  if (!rows.length) {
    lines.push('尚未观察到任何 agent 的 reasoning。');
    return lines.join('\n');
  }
  lines.push('agent                            块      咏唱句   峰值块  偏高   触发  压缩成/败  最近判决');
  for (const row of rows) {
    const last = row.lastVerdict ? row.lastVerdict.reasons.join('; ') : '-';
    const compact = `${row.compacted}/${row.compactFailed}`;
    lines.push(
      `${row.label.padEnd(32)} ${String(row.totalBlocks).padStart(5)} ${String(row.totalChant).padStart(8)} ${String(row.peakBlock).padStart(8)} ${String(row.elevatedBlocks).padStart(6)} ${String(row.fired).padStart(6)} ${compact.padStart(10)}  ${last}`
    );
  }
  return lines.join('\n');
}

/**
 * 安装护栏。
 * @param ctx cordis 上下文。
 * @param config 插件配置，见 chant.js 的 DEFAULT_CONFIG。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  const states = new Map();
  const activeControllers = new Set();
  let disposed = false;
  const log = (...args) => {
    if (cfg.verbose) console.log('[reasoning-guard]', ...args);
  };
  const warn = (...args) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[reasoning-guard]', ...args);
      else console.warn('[reasoning-guard]', ...args);
    } catch {
      console.warn('[reasoning-guard]', ...args);
    }
  };

  const goalsService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('goals') : undefined;
    } catch {
      return undefined;
    }
  };

  const compactionService = (agent) => {
    try {
      const presets = ctx.get?.('agentPresets');
      // preset 的 compaction 位于 entry-local realm，host ctx 和 agent.ctx 都看不到。
      return presets?.serviceFor(agent, 'compaction') ?? ctx.get?.('compaction');
    } catch {
      return undefined;
    }
  };

  const compactionAvailable = () => {
    if (states.size === 0) return null;
    for (const agent of states.keys()) {
      if (typeof compactionService(agent)?.compactNow === 'function') return true;
    }
    try {
      return typeof ctx.get?.('compaction')?.compactNow === 'function';
    } catch {
      return false;
    }
  };

  /** idle 事件内立即占用 maintenance，抢在 goal driver 的下一轮微任务前。 */
  function startCompact(agent, state) {
    const pending = state.pendingCompact;
    if (!pending || state.compactRun || agent.phase?.kind !== 'idle') return;
    state.pendingCompact = null;
    if (!pending.service) {
      if (pending.pausedView && cfg.resumeGoal) resumeGoal(agent, pending.pausedView);
      state.recovery = null;
      return;
    }
    const controller = new AbortController();
    activeControllers.add(controller);
    let operation;
    try {
      operation = Promise.resolve(pending.service.compactNow(agent, controller.signal));
    } catch (error) {
      operation = Promise.reject(error);
    }
    let timer;
    const timeout = cfg.compactTimeoutMs > 0 ? new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('reasoning-guard compact timeout'));
        resolve({ kind: 'timeout' });
      }, cfg.compactTimeoutMs);
      timer.unref?.();
    }) : null;
    const run = Promise.race([operation.then(
      (result) => ({ kind: 'result', result }),
      (error) => ({ kind: 'error', error }),
    ), ...(timeout ? [timeout] : [])]);
    state.compactRun = run;
    run.then((outcome) => {
      if (timer) clearTimeout(timer);
      activeControllers.delete(controller);
      if (state.compactRun === run) state.compactRun = null;
      if (outcome.kind === 'result' && outcome.result) state.guard.compacted++;
      else state.guard.compactFailed++;
      if (outcome.kind === 'timeout') warn(`自动压缩超时（${cfg.compactTimeoutMs}ms），已请求取消`);
      else if (outcome.kind === 'error') warn(`自动压缩未成功: ${outcome.error?.message ?? outcome.error}`);
      log(`auto-compact: ${outcome.kind}`);
      resetDetection(state.guard);
      if (!disposed && pending.pausedView && cfg.resumeGoal) resumeGoal(agent, pending.pausedView);
      state.recovery = null;
    });
  }

  function stateFor(agent) {
    let state = states.get(agent);
    if (state) {
      // 刷新插入顺序：Map 对已存在 key 的 set 不改变位置，不重插的话
      // 淘汰的是"最早见过"而不是"最久不活跃"。
      states.delete(agent);
      states.set(agent, state);
      return state;
    }
    if (states.size >= MAX_AGENTS) {
      const oldest = [...states].find(([owner, candidate]) => owner.status !== 'running'
        && !candidate.live && !candidate.queuedVerdict && !candidate.pendingCompact && !candidate.compactRun)?.[0];
      if (oldest) {
        clearTimeout(states.get(oldest).budgetTimer);
        states.delete(oldest);
      }
    }
    state = { guard: createGuardState(), label: String(agent?.id ?? 'agent').slice(0, 32) };
    states.set(agent, state);
    return state;
  }

  /** 暂停 goal：切断 goal-round driver 在 idle 后继续排轮的链条。
   *  返回暂停后的视图（revision 已推进），resume 必须用这个新 revision。 */
  function pauseGoal(agent) {
    const goals = goalsService();
    if (!goals) return null;
    try {
      const goal = goals.get(agent);
      if (!goal || goal.phase !== 'active') return null;
      const view = goals.pause(agent, { id: goal.id, revision: goal.revision });
      return view && typeof view === 'object' ? view : goal;
    } catch (error) {
      warn('goal 暂停失败:', String(error));
      return null;
    }
  }

  /** 压缩结算后恢复 goal；pause/resume 更新 revision，避免旧轮次重新占用驱动。 */
  function resumeGoal(agent, pausedView) {
    const goals = goalsService();
    if (!goals || !pausedView) return false;
    try {
      goals.resume(agent, { id: pausedView.id, revision: pausedView.revision });
      return true;
    } catch (error) {
      warn(`goal 恢复失败（可能已达 maxGoalRounds 预算），需要手动恢复: ${String(error)}`);
      return false;
    }
  }

  function cancelTurn(agent) {
    try {
      if (agent.status !== 'running') return false;
      agent.cancel({ kind: 'parent' }, { keepInbox: true });
      return true;
    } catch (error) {
      warn('当前 turn 取消失败:', String(error));
      return false;
    }
  }

  /** 越线后的处置。stats 为 null 表示来自预算档而非咏唱档。 */
  function handleVerdict(agent, state, verdict, stats) {
    const head = stats
      ? `agent=${state.label} turn=${verdict.turn} 块=${stats.blocks} 句=${stats.lines} 咏唱=${stats.chantLines}(${(stats.ratio * 100).toFixed(0)}%)`
      : `agent=${state.label} turn=${verdict.turn} 步数=${verdict.steps} 用时=${verdict.minutes.toFixed(1)}分`;
    warn(`${stats ? '思考咏唱退化' : '单轮预算超支'} ${head} :: ${verdict.reasons.join('; ')}`);

    const alreadyCompact = Boolean(state.pendingCompact || state.compactRun);
    const service = cfg.autoCompact && !alreadyCompact ? compactionService(agent) : null;
    const canCompact = typeof service?.compactNow === 'function';
    if (cfg.autoCompact && !alreadyCompact && !canCompact) state.guard.compactFailed++;
    if (canCompact) state.pendingCompact = { service, pausedView: null };

    let extra = '';
    let pausedView = null;
    if ((cfg.action === 'pause-goal' || cfg.action === 'cancel') && !alreadyCompact) {
      pausedView = pauseGoal(agent);
      if (pausedView) extra += ` goal(${pausedView.roundsStarted}/${pausedView.maxGoalRounds}) 已暂停`;
    }
    // A pause from an agent's own driver chain does not cancel it in dsh.
    // The guard owns cancellation explicitly, preserving queued user messages.
    if (!alreadyCompact && (cfg.action === 'cancel' || (cfg.action === 'pause-goal' && pausedView))) {
      if (cancelTurn(agent)) extra += ' 当前 turn 已取消';
    }
    if (cfg.action === 'pause-goal' && pausedView && cfg.resumeGoal) {
      state.pendingCompact ??= { service: null, pausedView: null };
      state.pendingCompact.pausedView = pausedView;
      state.recovery = pausedView;
    }
    if (state.pendingCompact) startCompact(agent, state);
    if (extra) warn(`已处置:${extra}`);
  }

  // SessionStore forbids appending goal/change while publishing another event.
  // Queue only the action; counts remain synchronous and streaming stays bounded.
  function scheduleVerdict(agent, state, verdict) {
    if (state.queuedVerdict) return;
    const session = agent.session;
    state.queuedVerdict = verdict;
    queueMicrotask(() => {
      if (disposed || states.get(agent) !== state || agent.session !== session
          || ctx.agents.get(agent.id) !== agent) return;
      state.queuedVerdict = null;
      if (agent.phase?.kind === 'running' && agent.phase.turn !== undefined
          && agent.phase.turn !== verdict.turn) return;
      try { handleVerdict(agent, state, verdict, verdict.stats); }
      catch (error) { warn(`护栏处置失败: ${error}`); }
    });
  }

  function budgetVerdict(agent, state, verdict) {
    if (!verdict) return false;
    const recorded = recordVerdict(state.guard, verdict, Date.now(), cfg);
    if (recorded) scheduleVerdict(agent, state, recorded);
    return Boolean(recorded);
  }

  function armBudgetTimer(agent, state, turn) {
    clearTimeout(state.budgetTimer);
    if (!cfg.maxTurnMinutes) return;
    const deadline = state.guard.budget.startedAt + cfg.maxTurnMinutes * 60000;
    const tick = () => {
      if (disposed || states.get(agent) !== state || state.guard.budget.turn !== turn
          || agent.status !== 'running') return;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        state.budgetTimer = setTimeout(tick, Math.min(remaining, 2147483647));
        state.budgetTimer.unref?.();
        return;
      }
      if (!budgetVerdict(agent, state, checkBudget(state.guard, turn, Date.now(), cfg, false))) {
        // A content verdict just before the deadline must not permanently hide
        // a time-budget verdict when the stream subsequently stalls.
        const delay = Math.max(1, state.guard.lastFiredAt + cfg.cooldownMs - Date.now());
        state.budgetTimer = setTimeout(tick, Math.min(delay, 2147483647));
        state.budgetTimer.unref?.();
      }
    };
    state.budgetTimer = setTimeout(tick, Math.max(1, Math.min(deadline - Date.now(), 2147483647)));
    state.budgetTimer.unref?.();
  }

  ctx.effect(function* install() {
    ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (!['assistant/message', 'step/start', 'turn/start', 'turn/end'].includes(type)) return;
      let agent;
      try {
        agent = ctx.agents.get(session.id);
      } catch {
        return;
      }
      if (!agent || agent.session !== session) return;

      const state = stateFor(agent);
      const turn = event.data?.turn ?? 0;
      if (type === 'turn/end') {
        clearTimeout(state.budgetTimer);
        return;
      }
      if (type === 'turn/start') {
        resetDetection(state.guard, turn);
        checkBudget(state.guard, turn, Date.now(), cfg, false);
        armBudgetTimer(agent, state, turn);
        return;
      }
      if (type === 'step/start') {
        const newTurn = state.guard.budget.turn !== turn;
        const verdict = checkBudget(state.guard, turn, Date.now(), cfg);
        if (newTurn) armBudgetTimer(agent, state, turn);
        budgetVerdict(agent, state, verdict);
        return;
      }

      const text = reasoningOf(event.data?.message);
      if (!text) return;

      const stats = analyzeReasoningText(text);
      if (!stats.lines) return;

      // 预警档只计数：每块末尾带一两句行动宣告的正常思考会落在这一档，
      // 值得观察，不值得处置。
      if (stats.chantLines >= cfg.elevatedBlockLimit) {
        state.guard.elevatedBlocks++;
        log(
          `elevated: agent=${state.label} turn=${event.data?.turn} 单块咏唱 ${stats.chantLines} 句`
          + `（占比 ${(stats.ratio * 100).toFixed(0)}%，处置阈值 ${cfg.perBlockLimit}）`
        );
      }

      const streamed = state.live?.turn === turn && state.live?.step === event.data?.step && state.live.fired;
      const verdict = evaluateBlock(state.guard, stats, turn, cfg, Date.now(), streamed);
      if (verdict) scheduleVerdict(agent, state, verdict);
    });

    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (disposed || ctx.agents.get(agent.id) !== agent) return;
      const state = stateFor(agent);
      if (frame.type === 'start') {
        state.live = { id: frame.attemptId, turn: frame.turn, step: frame.step, blocks: new Map(), fired: false, index: -1 };
        return;
      }
      const live = state.live;
      if (!live || live.id !== frame.attemptId) return;
      if (frame.type === 'end') { state.live = null; return; }
      if (frame.type !== 'chunk' || frame.index <= live.index) return;
      live.index = frame.index;
      if (live.fired) return;
      const chunk = frame.chunk;
      if (chunk.type !== 'reasoning-delta' && !(chunk.type === 'block-end' && chunk.block?.type === 'reasoning')) return;
      let block = live.blocks.get(chunk.index);
      if (!block) {
        block = { analyzer: createReasoningAnalyzer(), deltas: false };
        live.blocks.set(chunk.index, block);
      }
      if (chunk.type === 'reasoning-delta') {
        block.deltas = true;
        block.analyzer.push(chunk.text);
      } else {
        // Some adapters publish a complete block without deltas; never add it twice.
        if (!block.deltas) block.analyzer.push(chunk.block.text);
        block.analyzer.finish();
      }
      const stats = { lines: 0, chantLines: 0, ratio: 0, maxRun: 0, blocks: 0, maxRepeatRun: 0 };
      for (const entry of live.blocks.values()) {
        const row = entry.analyzer.snapshot();
        stats.lines += row.lines;
        stats.chantLines += row.chantLines;
        stats.blocks += row.blocks;
        stats.maxRun = Math.max(stats.maxRun, row.maxRun);
        stats.maxRepeatRun = Math.max(stats.maxRepeatRun, row.maxRepeatRun);
      }
      stats.ratio = stats.lines ? stats.chantLines / stats.lines : 0;
      const verdict = previewBlock(state.guard, stats, live.turn, cfg, Date.now());
      if (verdict) {
        live.fired = true;
        scheduleVerdict(agent, state, verdict);
      }
    });

    // 可选干预：在退化块之后的下一步前面插入一条收敛提醒。
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const state = states.get(agent);
      if (!cfg.intervene || !state || !state.guard.pendingIntervention) return next();
      if (signal?.aborted) return next();
      const decision = await next();
      if (!decision || decision.kind !== 'enter') return decision;

      // 预算触发的病灶是无限穷举而非复读，用对应的提醒文本。
      const budgetFire = Boolean(state.guard.lastVerdict) && state.guard.lastVerdict.stats === null;
      const reminder = await buildReminder(budgetFire ? cfg.budgetReminderText : cfg.reminderText);
      if (!reminder || signal?.aborted) return decision;
      state.guard.pendingIntervention = false;
      log('injected reminder into step', decision.messages?.length);
      return { ...decision, messages: [...(decision.messages ?? []), reminder] };
    });

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') {
        const state = states.get(agent);
        if (state) {
          clearTimeout(state.budgetTimer);
          startCompact(agent, state);
        }
      }
    });

    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent);
      clearTimeout(state?.budgetTimer);
      if (state?.pendingCompact?.pausedView && cfg.resumeGoal) {
        // 已销毁的 agent 不再有后续轮次，避免把暂停状态误归因于压缩成功。
        log('agent disposed before pending compaction', agent.id);
      }
      states.delete(agent);
    });

    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register({
        name: 'guard_status',
        description:
          '查看 dsh-reasoning-guard（思考咏唱护栏）的实时状态：每个 agent 的 reasoning 块数、咏唱句数、峰值块、触发次数与最近一次判决。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute() {
          const rows = [];
          for (const state of states.values()) {
            rows.push({
              label: state.label,
              totalBlocks: state.guard.totalBlocks,
              totalChant: state.guard.totalChant,
              peakBlock: state.guard.peakBlock,
              elevatedBlocks: state.guard.elevatedBlocks,
              fired: state.guard.fired,
              compacted: state.guard.compacted,
              compactFailed: state.guard.compactFailed,
              lastVerdict: state.guard.lastVerdict,
            });
          }
          return { text: renderReport(rows, cfg, compactionAvailable()) };
        },
      });
    }

    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    if (commands && typeof commands.register === 'function') {
      commands.register({
        name: 'guard',
        description: '思考咏唱护栏：status | reset',
        input: { hint: 'status | reset' },
        handler: async (invocation) => {
          const action = String(invocation?.rawInput ?? '').trim().toLowerCase();
          // dsh 命令注册表要求 handler 返回 CommandResult（{kind, text}），纯字符串会被拒绝。
          if (action === 'reset') {
            const count = states.size;
            let inFlight = 0;
            for (const state of states.values()) {
              if (state.compactRun || state.pendingCompact || state.queuedVerdict) inFlight++;
              // Reset statistics, never erase recovery, timer or stream ownership.
              state.guard = { ...createGuardState(), budget: state.guard.budget };
            }
            return {
              kind: 'success',
              text: `reasoning-guard：已清空 ${count} 个 agent 的统计`
                + (inFlight ? `；${inFlight} 个在飞压缩保留归属，落定后的计数计入新统计` : '')
                + '。',
            };
          }
          const rows = [];
          for (const state of states.values()) {
            rows.push({
              label: state.label,
              totalBlocks: state.guard.totalBlocks,
              totalChant: state.guard.totalChant,
              peakBlock: state.guard.peakBlock,
              elevatedBlocks: state.guard.elevatedBlocks,
              fired: state.guard.fired,
              compacted: state.guard.compacted,
              compactFailed: state.guard.compactFailed,
              lastVerdict: state.guard.lastVerdict,
            });
          }
          return { kind: 'success', text: renderReport(rows, cfg, compactionAvailable()) };
        },
      });
    }

    log('installed', JSON.stringify({ action: cfg.action, perBlockLimit: cfg.perBlockLimit }));

    yield () => {
      disposed = true;
      for (const state of states.values()) clearTimeout(state.budgetTimer);
      for (const controller of activeControllers) controller.abort(new Error('reasoning-guard disposed'));
      activeControllers.clear();
      if (cfg.resumeGoal) {
        for (const [agent, state] of states) {
          if (state.recovery) resumeGoal(agent, state.recovery);
        }
      }
      states.clear();
    };
  }, 'reasoning-guard lifecycle');
}
