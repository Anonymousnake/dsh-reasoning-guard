/**
 * dsh-reasoning-guard — 思考咏唱护栏。
 *
 * 解决问题：模型在长任务、反复失败时，reasoning 正文会退化成「好。/执行。/写。/GO。」
 * 这类行动宣告的复读机；dsh 的"思考"区以 white-space: pre-wrap 原样渲染每一段，
 * 于是用户看到一屏接一屏的重复短句，等同死循环。实测某会话 34529 行 reasoning 里
 * 20914 行是这类短句。
 *
 * 本插件在会话事件流上统计该现象，越线后告警，并按配置自动压缩上下文、暂停 goal
 * （切断退化轮的续命链后自动恢复，自动化继续）或取消当前 turn；可选地在下一步注入
 * 收敛提醒。一切处置的前提都是自动化不中断。
 *
 * 零外部静态依赖：只 import node: 内置模块与同目录 chant.js，缺失 @deepseek-ai/dsh-llm
 * 时自动降级，不阻断加载。
 */

import { randomUUID } from 'node:crypto';
import {
  analyzeReasoningText,
  checkBudget,
  createGuardState,
  evaluateBlock,
  resolveConfig,
} from './chant.js';

export const name = 'reasoning-guard';

/** agents/tools 必须声明：cordis 禁止访问未声明的服务属性。
 *  goals/commands/compaction 走 ctx.get 动态读取（可选依赖，缺失时降级），无需声明。 */
export const inject = ['agents', 'tools'];

const MAX_AGENTS = 256;

/** 给 promise 加等待上限：到点解析为 'timeout'，原 promise 继续在后台落定。 */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  timer.unref?.();
  return Promise.race([promise, timeout]);
}

/** 取 reasoning 块正文，兼容 content 里混排的 text / tool-call 块。 */
function reasoningOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') out += block.text;
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
    `阈值: 单块 ${cfg.perBlockLimit} 行 | ${cfg.windowBlocks} 块累计 ${cfg.windowLimit} 行 | 单 turn ${cfg.turnLimit} 行 | 预警档 ${cfg.elevatedBlockLimit} 行`
  );
  lines.push(
    `预算: 单 turn ${cfg.maxStepsPerTurn} 步 | ${cfg.maxTurnMinutes} 分钟（0 表示禁用）`
  );
  const compactState = cfg.autoCompact
    ? (compactionAvailable ? '自动压缩开' : '自动压缩开但服务不可用')
    : '自动压缩关';
  lines.push(
    `动作: ${cfg.action}${cfg.intervene ? ' + 注入收敛提醒' : ''} | ${compactState} | 冷却 ${Math.round(cfg.cooldownMs / 1000)}s`
  );
  lines.push('');
  if (!rows.length) {
    lines.push('尚未观察到任何 agent 的 reasoning。');
    return lines.join('\n');
  }
  lines.push('agent                            块      咏唱行   峰值块  偏高   触发  压缩成/败  最近判决');
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

  const compactionService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('compaction') : undefined;
    } catch {
      return undefined;
    }
  };

  /** 压缩服务是否真的可用 —— 不可用时 autoCompact 只会静默跳过，必须让它可见。 */
  const compactionAvailable = () => {
    const service = compactionService();
    return Boolean(service && typeof service.compactNow === 'function');
  };

  /**
   * 越线后自动压缩一次上下文。
   *
   * 压缩清掉的是复读痕迹、留下的是任务事实，因此它比"暂停 goal"更接近治本：
   * 前者只是让循环停下来，后者把循环赖以自我模仿的材料一起清走。
   * 异步 fire-and-forget —— 压缩要调一次模型生成摘要，不能阻塞事件处理。
   *
   * 同一 agent 串行：压缩经常比冷却期更久，超预算后每步都可能再次触发，
   * 在飞时的新触发等它落定而不是叠加 —— 压缩实现在摘要期做 surface 校验，
   * 并发必然失败一方（SurfaceChangedError）。
   */
  function autoCompact(agent, state) {
    const compaction = compactionService();
    if (!compaction || typeof compaction.compactNow !== 'function') {
      state.guard.compactFailed++;
      return Promise.resolve('unavailable');
    }
    if (state.compactRun) {
      return withTimeout(state.compactRun.then(() => 'in-flight'), cfg.compactTimeoutMs);
    }
    const run = Promise.resolve()
      .then(() => compaction.compactNow(agent, undefined, undefined))
      .then(
        (result) => {
          if (result) {
            state.guard.compacted++;
            return `ok shadowed=${result.shadowedTokenCount ?? '?'}`;
          }
          state.guard.compactFailed++;
          return 'no-safe-range';
        },
        (error) => {
          state.guard.compactFailed++;
          return `failed: ${error?.message ?? error}`;
        },
      );
    state.compactRun = run;
    run.then(() => {
      if (state.compactRun === run) state.compactRun = null;
    });
    return withTimeout(run, cfg.compactTimeoutMs);
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
      const oldest = states.keys().next().value;
      states.delete(oldest);
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
      log('pause failed:', String(error));
      return null;
    }
  }

  /** 恢复 goal：自动化必须继续 —— 暂停只为让压缩趁 turn 活着跑完，并让驱动的
   *  僵尸 attempt 保护失效（pause/resume 各推进一次 revision，被取消的旧 attempt
   *  revision 对不上，不会在 idle 时被再次暂停）。恢复后驱动在 agent idle 时
   *  自动排下一轮，此时上下文已经压缩。 */
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
      agent.cancel({ kind: 'parent' });
      return true;
    } catch (error) {
      log('cancel failed:', String(error));
      return false;
    }
  }

  /** 越线后的处置。stats 为 null 表示来自预算档而非咏唱档。 */
  async function handleVerdict(agent, state, verdict, stats) {
    const head = stats
      ? `agent=${state.label} turn=${verdict.turn} 块=${stats.blocks} 行=${stats.lines} 咏唱=${stats.chantLines}(${(stats.ratio * 100).toFixed(0)}%)`
      : `agent=${state.label} turn=${verdict.turn} 步数=${verdict.steps} 用时=${verdict.minutes.toFixed(1)}分`;
    warn(`${stats ? '思考咏唱退化' : '单轮预算超支'} ${head} :: ${verdict.reasons.join('; ')}`);

    // 压缩必须排在暂停之前。goal 的 pause 会被 goal-round-driver 转成
    // agent.cancel({kind:"user"})，当前 turn 立刻中止，压缩就没机会跑完 ——
    // 那正是"只中断、不压缩"的成因。
    if (cfg.autoCompact) {
      const outcome = await autoCompact(agent, state);
      log(`auto-compact: ${outcome}`);
      if (String(outcome).startsWith('failed')) warn(`自动压缩未成功: ${outcome}`);
      else if (outcome === 'timeout') warn(`自动压缩超时（${cfg.compactTimeoutMs}ms），继续后续处置；压缩仍在后台尝试落定（若处置中止 turn，可能因 surface 变化失败并计入失败数）`);
    }

    let extra = '';
    let pausedView = null;
    if (cfg.action === 'pause-goal' || cfg.action === 'cancel') {
      pausedView = pauseGoal(agent);
      if (pausedView) extra += ` goal(${pausedView.roundsStarted}/${pausedView.maxGoalRounds}) 已暂停`;
    }
    if (cfg.action === 'cancel') {
      if (cancelTurn(agent)) extra += ' 当前 turn 已取消';
    }
    // 暂停不终局：压缩已趁 turn 活着完成，立即恢复 armed，驱动在 idle 时自动
    // 排下一轮。仅 pause-goal 档恢复；cancel 是显式的硬手段，保留暂停语义。
    if (cfg.action === 'pause-goal' && pausedView && cfg.resumeGoal) {
      if (resumeGoal(agent, pausedView)) extra += ' → 已恢复（自动化继续）';
    }
    if (extra) warn(`已处置:${extra}`);
  }

  ctx.effect(function* install() {
    ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (type !== 'assistant/message' && type !== 'step/start') return;
      let agent;
      try {
        agent = ctx.agents.get(session.id);
      } catch {
        return;
      }
      if (!agent || agent.session !== session) return;

      const state = stateFor(agent);

      // 预算档：每步检查一次。抓的不是复读，是没有验收标准的无限穷举 ——
      // 实测失控会话 130 步 / 1 小时 27 分，其中 98% 的步骤都在产出新信息。
      if (type === 'step/start') {
        const verdict = checkBudget(state.guard, event.data?.turn ?? 0, Date.now(), cfg);
        if (verdict) {
          const now = Date.now();
          if (now - state.guard.lastFiredAt >= cfg.cooldownMs) {
            state.guard.lastFiredAt = now;
            // 与咏唱档（evaluateBlock）对齐：触发计数、最近判决、干预标记都要落。
            state.guard.fired++;
            verdict.fired = state.guard.fired;
            state.guard.lastVerdict = verdict;
            state.guard.pendingIntervention = true;
            handleVerdict(agent, state, verdict, null).catch((error) => warn(`预算处置失败: ${error}`));
          }
        }
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
          `elevated: agent=${state.label} turn=${event.data?.turn} 单块咏唱 ${stats.chantLines} 行`
          + `（占比 ${(stats.ratio * 100).toFixed(0)}%，处置阈值 ${cfg.perBlockLimit}）`
        );
      }

      const verdict = evaluateBlock(state.guard, stats, event.data?.turn ?? 0, cfg, Date.now());
      if (verdict) handleVerdict(agent, state, verdict, stats).catch((error) => warn(`咏唱处置失败: ${error}`));
    });

    // 可选干预：在退化块之后的下一步前面插入一条收敛提醒。
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const state = states.get(agent);
      if (!cfg.intervene || !state || !state.guard.pendingIntervention) return next();
      if (signal?.aborted) return next();
      state.guard.pendingIntervention = false;

      const decision = await next();
      if (!decision || decision.kind !== 'enter') return decision;

      // 预算触发的病灶是无限穷举而非复读，用对应的提醒文本。
      const budgetFire = Boolean(state.guard.lastVerdict) && state.guard.lastVerdict.stats === null;
      const reminder = await buildReminder(budgetFire ? cfg.budgetReminderText : cfg.reminderText);
      if (!reminder || signal?.aborted) return decision;
      log('injected reminder into step', decision.messages?.length);
      return { ...decision, messages: [...(decision.messages ?? []), reminder] };
    });

    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent);
    });

    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register({
        name: 'guard_status',
        description:
          '查看 dsh-reasoning-guard（思考咏唱护栏）的实时状态：每个 agent 的 reasoning 块数、咏唱行数、峰值块、触发次数与最近一次判决。',
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
            for (const [agent, state] of states) {
              if (state.compactRun) {
                // 在飞压缩的计数要落到原状态对象上：保留身份、只换新 guard，
                // 落定后的 compacted/compactFailed 会写进新统计。
                inFlight++;
                state.guard = createGuardState();
              } else {
                states.delete(agent);
              }
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
      states.clear();
    };
  }, 'reasoning-guard lifecycle');
}
