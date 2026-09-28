/**
 * 空跑：用 mock ctx 驱动 apply，验证事件链路真的会在退化时触发处置。
 * 不需要启动 dsh，也不需要真实 goal。
 *
 * 用法：node test/dryrun.mjs
 */

import { apply } from '../lib/index.js';
import { checkBudget, createGuardState, resolveConfig } from '../lib/chant.js';

const handlers = new Map();
const warns = [];
let pausedRef = null;
let resumedRef = null;
let registeredTool = null;
const commandNames = [];
let compactCalls = 0;
let compactMode = 'instant';
let compactStartedBeforePause = null;
const heldCompactions = [];

const goal = { id: 'goal-1', revision: 3, phase: 'active', roundsStarted: 2, maxGoalRounds: 256 };
const session = { id: 'sess-1' };
const agent = { id: 'agent-1', status: 'running', session };

const ctx = {
  logger: { warn: (...args) => warns.push(args.join(' ')) },
  on: (eventName, handler) => {
    if (!handlers.has(eventName)) handlers.set(eventName, []);
    handlers.get(eventName).push(handler);
  },
  get: (service) => {
    if (service === 'goals') {
      return {
        get: () => goal,
        pause: (_agent, ref) => {
          pausedRef = ref;
          // 与 dsh-goal 一致：pause 推进 revision 并返回暂停后的视图。
          return { ...goal, phase: 'paused', revision: goal.revision + 1 };
        },
        resume: (_agent, ref) => {
          resumedRef = ref;
          return { ...goal, phase: 'active', revision: ref.revision + 1 };
        },
      };
    }
    if (service === 'commands') {
      return { register: (spec) => commandNames.push(spec.name) };
    }
    if (service === 'compaction') {
      return {
        compactNow: () => {
          compactCalls++;
          compactStartedBeforePause = pausedRef === null;
          if (compactMode === 'hold') {
            return new Promise((resolve) => heldCompactions.push(resolve));
          }
          return Promise.resolve({ shadowedTokenCount: 1234 });
        },
      };
    }
    return undefined;
  },
  tools: { register: (tool) => { registeredTool = tool; } },
  agents: { get: (id) => (id === 'sess-1' ? agent : undefined) },
  effect: (factory) => {
    const iterator = factory();
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  },
};

apply(ctx, { cooldownMs: 0, maxStepsPerTurn: 5, maxTurnMinutes: 0, action: 'pause-goal', verbose: false });

function emit(event) {
  for (const handler of handlers.get('session/event') ?? []) handler(session, event);
}

/** 造一个退化块：整块几乎全是行动宣告。 */
function degradedReasoning(count) {
  const words = ['好。', '执行。', '**GO！**', '写。', '（写）', 'OK.'];
  return Array.from({ length: count }, (_, i) => words[i % words.length]).join('\n\n');
}

/** 造一个正常块：有实质分析，只带一两句小结。 */
const healthyReasoning = [
  '先确认目标进程的模块基址，再决定 patch 点。',
  '',
  '从日志看，`LMX_Checkout` 返回 9 说明 feature 未授权。',
  '',
  '需要验证的是调用点的分支条件，而不是字符串本身。',
  '',
  '好。',
].join('\n');

const results = [];

// 1) 正常块不应触发
warns.length = 0;
pausedRef = null;
emit({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: healthyReasoning }] } } });
results.push(['正常 reasoning 不触发', warns.length === 0 && pausedRef === null]);

// 2) 退化块应触发告警并暂停 goal
warns.length = 0;
pausedRef = null;
resumedRef = null;
compactStartedBeforePause = null;
emit({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'reasoning', text: degradedReasoning(80) }] } } });
results.push(['退化块触发告警', warns.some((w) => w.includes('思考咏唱退化'))]);
// 处置链是 async（压缩先于暂停），等它跑完再断言暂停
await new Promise((resolve) => setTimeout(resolve, 20));
results.push(['退化块暂停 goal', pausedRef !== null && pausedRef.id === 'goal-1' && pausedRef.revision === 3]);
results.push(['压缩先于暂停', compactStartedBeforePause === true]);
// resume 必须用暂停后的 revision（pause 已把 3 推进到 4）
results.push(['暂停后自动恢复 goal', resumedRef !== null && resumedRef.revision === 4]);

// 3) 预警档：计数但不处置（模拟"每块末尾带一两句行动宣告"的正常偏高思考）
warns.length = 0;
pausedRef = null;
emit({ type: 'assistant/message', data: { turn: 9, step: 1, message: { content: [{ type: 'reasoning', text: degradedReasoning(24) }] } } });
results.push(['预警档不处置会话', warns.length === 0 && pausedRef === null]);

// 4) 非 reasoning 的 assistant 消息应被忽略
warns.length = 0;
emit({ type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '好。\n\n执行。\n\n写。' }] } } });
results.push(['纯 text 块不计入', warns.length === 0]);

// 5) 无关事件类型应被忽略
warns.length = 0;
emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
results.push(['无关事件被忽略', warns.length === 0]);

// 6) 预算档：步数未超时不处置，超了才处置（阈值 5）
warns.length = 0;
pausedRef = null;
resumedRef = null;
for (let s = 1; s <= 5; s++) emit({ type: 'step/start', data: { turn: 42, step: s } });
results.push(['步数未超预算不处置', warns.length === 0 && pausedRef === null]);
for (let s = 6; s <= 7; s++) emit({ type: 'step/start', data: { turn: 42, step: s } });
results.push(['步数超预算触发处置', warns.some((w) => w.includes('单轮预算超支'))]);
await new Promise((resolve) => setTimeout(resolve, 20));
results.push(['预算超支也暂停 goal', pausedRef !== null]);
results.push(['预算触发后也自动恢复', resumedRef !== null]);
const budgetReport = String((await registeredTool.execute())?.text ?? '');
results.push(['预算触发记入最近判决', budgetReport.includes('本 turn 步数')]);

// 7) checkBudget 纯函数：步数、时长、禁用三条路径
const budgetState = createGuardState();
const budgetCfg = { maxStepsPerTurn: 3, maxTurnMinutes: 10 };
checkBudget(budgetState, 1, 1000, budgetCfg);
checkBudget(budgetState, 1, 2000, budgetCfg);
checkBudget(budgetState, 1, 3000, budgetCfg);
const overSteps = checkBudget(budgetState, 1, 4000, budgetCfg);
results.push(['checkBudget 步数超支', overSteps !== null && overSteps.steps === 4]);
checkBudget(budgetState, 2, 0, budgetCfg);
const overTime = checkBudget(budgetState, 2, 11 * 60000, budgetCfg);
results.push(['checkBudget 时长超支', overTime !== null && overTime.reasons.some((r) => r.includes('分钟'))]);
const offCfg = { maxStepsPerTurn: 0, maxTurnMinutes: 0 };
checkBudget(budgetState, 3, 0, offCfg);
results.push(['预算可整体禁用', checkBudget(budgetState, 3, 0, offCfg) === null]);

// 8) 越线后自动压缩（异步 fire-and-forget）
await new Promise((resolve) => setTimeout(resolve, 30));
results.push(['越线后自动压缩', compactCalls > 0]);

// 8.5) 压缩在飞保护：在飞时的新触发等它落定，不叠加压缩
compactMode = 'hold';
warns.length = 0;
pausedRef = null;
resumedRef = null;
emit({ type: 'assistant/message', data: { turn: 60, step: 1, message: { content: [{ type: 'reasoning', text: degradedReasoning(80) }] } } });
await new Promise((resolve) => setTimeout(resolve, 20));
const callsInFlight = compactCalls;
emit({ type: 'assistant/message', data: { turn: 60, step: 2, message: { content: [{ type: 'reasoning', text: degradedReasoning(80) }] } } });
await new Promise((resolve) => setTimeout(resolve, 20));
results.push(['压缩在飞时不叠加', compactCalls === callsInFlight && pausedRef === null]);
for (const resolve of heldCompactions.splice(0)) resolve({ shadowedTokenCount: 7 });
await new Promise((resolve) => setTimeout(resolve, 30));
results.push(['在飞压缩落定后完成处置', pausedRef !== null && resumedRef !== null && compactCalls === callsInFlight]);
compactMode = 'instant';

// 9) 工具与命令已注册
results.push(['guard_status 已注册', registeredTool?.name === 'guard_status']);
results.push(['/guard 命令已注册', commandNames.includes('guard')]);

// 10) 工具输出可渲染
const toolText = registeredTool.execute().then((value) => String(value?.text ?? ''));
results.push(['guard_status 可执行', true]);

const output = await toolText;
results.push(['状态含压缩计数', /压缩/.test(output)]);
results.push(['默认 action 是 warn（不中断）', resolveConfig({}).action === 'warn']);
results.push(['状态展示压缩可用性', /自动压缩开/.test(output)]);
results.push(['默认自动恢复 goal', resolveConfig({}).resumeGoal === true]);

let failed = 0;
for (const [label, ok] of results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log('\n--- guard_status 输出 ---');
console.log(output);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
