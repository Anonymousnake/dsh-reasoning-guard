import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { checkBudget, createGuardState, resolveConfig } from '../lib/chant.js';

const session = { id: 'sess-1' };
const agent = { id: 'agent-1', session, status: 'running', phase: { kind: 'running' } };
const handlers = new Map();
const order = [];
const warnings = [];
let goal = { id: 'goal-1', revision: 3, phase: 'active', roundsStarted: 2, maxGoalRounds: 256 };
let pendingCompact;
let compactCount = 0;
let compactSignal;
let compactionEnabled = true;
let registeredTool;
let registeredCommand;

const ctx = {
  logger: { warn: (...args) => warnings.push(args.join(' ')) },
  on: (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
  },
  get: (name) => {
    if (name === 'compaction') return undefined; // host realm cannot see the preset service
    if (name === 'agentPresets') return {
      serviceFor: (target, service) => compactionEnabled && target === agent && service === 'compaction' ? {
        compactNow: (_agent, signal) => {
          assert.equal(_agent, agent);
          assert.equal(agent.phase.kind, 'idle');
          assert.equal(signal.aborted, false);
          compactSignal = signal;
          order.push('compact');
          compactCount++;
          agent.phase = { kind: 'maintenance' };
          return new Promise((resolve) => { pendingCompact = resolve; });
        },
      } : undefined,
    };
    if (name === 'goals') return {
      get: () => goal,
      pause: (_agent, ref) => {
        assert.equal(ref.revision, goal.revision);
        order.push('pause');
        goal = { ...goal, phase: 'paused', revision: goal.revision + 1 };
        return goal;
      },
      resume: (_agent, ref) => {
        assert.equal(ref.revision, goal.revision);
        order.push('resume');
        goal = { ...goal, phase: 'active', revision: goal.revision + 1 };
        return goal;
      },
    };
    if (name === 'commands') return { register: (command) => { registeredCommand = command; } };
  },
  tools: { register: (tool) => { registeredTool = tool; } },
  agents: { get: (id) => id === session.id ? agent : undefined },
  effect: (factory) => {
    const iterator = factory();
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  },
};

let phaseAtDriverMicrotask;
ctx.on('agent/status', ({ status }) => {
  if (status === 'idle') queueMicrotask(() => { phaseAtDriverMicrotask = agent.phase.kind; });
});
apply(ctx, { cooldownMs: 0, maxStepsPerTurn: 5, maxTurnMinutes: 0, compactTimeoutMs: 20 });
const emit = (event) => {
  for (const fn of handlers.get('session/event') ?? []) fn(session, event);
};
const idle = () => {
  agent.phase = { kind: 'idle' };
  agent.status = 'idle';
  for (const fn of handlers.get('agent/status') ?? []) fn({ agent, status: 'idle' });
};
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
const degraded = (n) => Array.from({ length: n }, () => '好。').join('\n\n');
const reasoning = (text, turn) => emit({ type: 'assistant/message', data: {
  turn, message: { content: [{ type: 'reasoning', text }] },
} });

reasoning('先核对调用顺序及阈值，再确认状态。\n好。', 1);
assert.equal(order.length, 0);
reasoning(degraded(80), 2);
assert.deepEqual(order, ['pause']);
assert.equal(compactCount, 0);
reasoning(degraded(80), 2);
assert.equal(goal.revision, 4); // pending requests coalesce
idle();
assert.deepEqual(order, ['pause', 'compact']);
assert.equal(compactCount, 1);
assert.ok(compactSignal instanceof AbortSignal);
await drain();
assert.equal(phaseAtDriverMicrotask, 'maintenance');
pendingCompact({ shadowedTokenCount: 1234 });
await drain();
assert.deepEqual(order, ['pause', 'compact', 'resume']);
assert.equal(goal.phase, 'active');
assert.match((await registeredTool.execute()).text, /1\/0/);
assert.match((await registeredCommand.handler({ rawInput: '' })).text, /自动压缩开/);

// A second triggered turn tests no-op compaction and reset while maintenance runs.
agent.phase = { kind: 'running' };
agent.status = 'running';
reasoning(degraded(80), 3);
idle();
const reset = await registeredCommand.handler({ rawInput: 'reset' });
assert.match(reset.text, /在飞/);
pendingCompact(null);
await drain();
assert.equal(goal.phase, 'active');
assert.match((await registeredTool.execute()).text, /0\/1/);

// A stalled backend must release the goal at the timeout; a late result is ignored.
agent.phase = { kind: 'running' };
agent.status = 'running';
reasoning(degraded(80), 4);
idle();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(compactSignal.aborted, true);
assert.equal(goal.phase, 'active');
pendingCompact({ shadowedTokenCount: 99 });
await drain();
assert.match((await registeredTool.execute()).text, /0\/2/);
assert.ok(warnings.some((line) => line.includes('自动压缩超时')));

// When the preset has no compaction service, recovery still releases the goal.
compactionEnabled = false;
agent.phase = { kind: 'running' };
agent.status = 'running';
reasoning(degraded(80), 5);
assert.equal(goal.phase, 'active');
assert.equal(compactCount, 3);
assert.match((await registeredTool.execute()).text, /0\/3/);
assert.match((await registeredCommand.handler({ rawInput: '' })).text, /服务不可用/);

const budgetState = createGuardState();
const budgetCfg = { maxStepsPerTurn: 3, maxTurnMinutes: 10 };
for (let i = 0; i < 3; i++) assert.equal(checkBudget(budgetState, 1, i * 1000, budgetCfg), null);
assert.equal(checkBudget(budgetState, 1, 4000, budgetCfg).steps, 4);
checkBudget(budgetState, 2, 0, budgetCfg);
assert.ok(checkBudget(budgetState, 2, 11 * 60000, budgetCfg));
assert.equal(resolveConfig({}).action, 'pause-goal');
assert.ok(warnings.some((line) => line.includes('思考咏唱退化')));
console.log('PASS  preset 服务寻址、idle 压缩、合并、信号、超时、服务缺失、goal 恢复与统计重置');
