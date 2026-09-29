import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { GoalService } from '@deepseek-ai/dsh-goal';
import { createAssistantMessage, AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm';
import * as driver from '@deepseek-ai/dsh-goal-round-driver';
import * as guard from '../lib/index.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));
let fixtureId = 0;
async function fixture(t, config = {}, { compact, goal = true } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let statusTool, command;
  const tools = new Map(), commands = new Map();
  ctx.provide('tools', { register(tool) { statusTool = tool; tools.set(tool.name, tool); } });
  ctx.provide('commands', { register(value) { command = value; commands.set(value.name, value); } });
  if (compact) ctx.provide('agentPresets', { serviceFor: () => ({ compactNow: compact }) });
  ctx.plugin(AgentRegistry);
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(GoalService);
  ctx.plugin(driver);
  const guardFiber = ctx.plugin(guard, { cooldownMs: 0, maxStepsPerTurn: 0, maxTurnMinutes: 0, autoCompact: false, ...config });
  await drain();
  const agents = ctx.get('agents'), goals = ctx.get('goals');
  const session = ctx.get('sessions').create('guard-fixture-' + ++fixtureId);
  const cancellations = [];
  const agent = { id: session.id, session, ctx, status: 'running', phase: { kind: 'running', turn: 1 },
    inbox: { nextStep: [], nextTurn: [] },
    cancel(cause, options) { cancellations.push({ cause, options }); },
    followup(message) { this.inbox.nextTurn.push(message); },
    async whenIdle() {},
  };
  agents.register(agent);
  if (goal) goals.create(agent, { objective: 'In-memory regression fixture' });
  const append = (type, data, ...options) => agents.withInitiator(agent, () => session.append(type, data, ...options));
  const emit = (frame) => agents.withInitiator(agent, () => agentEvents(ctx, agent).emit('agent/assistant-stream', { frame }));
  const idle = () => {
    agent.phase = { kind: 'idle' };
    agent.status = 'idle';
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' });
  };
  async function report() {
    const text = (await statusTool.execute()).text;
    const row = text.split('\n').find((line) => line.startsWith(agent.id));
    const cols = row?.trim().split(/\s+/);
    return { text, blocks: Number(cols?.[1] ?? 0), chants: Number(cols?.[2] ?? 0),
      fired: Number(cols?.[5] ?? 0), compact: cols?.[6] };
  }
  const settle = (text, turn = 1, step = 1) => {
    const block = { type: 'reasoning', text };
    const stream = new AssistantStreamAccumulator();
    for (const chunk of [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text },
      { type: 'block-end', index: 0, block },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) stream.push({ time: Date.now(), chunk });
    append('assistant/message', { turn, step, message: createAssistantMessage({ content: [block],
      source: { provider: 'fixture', model: 'fixture' } }), stream: stream.snapshot() }, { surfaceOp: 'append' });
  };
  return { ctx, agents, goals, session, agent, append, emit, idle, settle, cancellations, report,
    reset: () => command.handler({ rawInput: 'reset' }), guardFiber, tools, commands,
    monitor: ctx.get('reasoningMonitor') };
}

test('real session publication defers goal writes and explicitly cancels its own initiator', async (t) => {
  const f = await fixture(t, { maxStepsPerTurn: 1 });
  f.append('turn/start', { turn: 1 });
  f.append('step/start', { turn: 1, step: 1 });
  f.append('step/end', { turn: 1, step: 1 });
  f.append('step/start', { turn: 1, step: 2 });
  assert.equal(f.goals.get(f.agent).phase, 'active', 'no reentrant goal write');
  await drain();
  assert.equal(f.goals.get(f.agent).phase, 'paused');
  assert.deepEqual(f.cancellations, [{ cause: { kind: 'parent' }, options: { keepInbox: true } }]);
  assert.equal((await f.report()).fired, 1);
  f.idle();
  assert.equal(f.goals.get(f.agent).phase, 'active', 'resume only after idle without compaction');
});

test('live stream triggers before settlement and counts its final message only once', async (t) => {
  const f = await fixture(t);
  f.emit({ type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 });
  for (let index = 0; index < 80; index++) {
    f.emit({ type: 'chunk', attemptId: 'attempt-1', index, chunk: { type: 'reasoning-delta', index: 0, text: '好。' } });
  }
  await drain();
  assert.equal(f.cancellations.length, 1);
  assert.equal((await f.report()).blocks, 0);
  f.settle('好。'.repeat(80));
  f.emit({ type: 'end', attemptId: 'attempt-1', index: 80, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 } });
  await drain();
  const report = await f.report();
  assert.equal(report.blocks, 1);
  assert.equal(report.chants, 80);
  assert.equal(report.fired, 1);
});

test('complete reasoning blocks without deltas are detected; unrelated frames are ignored', async (t) => {
  const f = await fixture(t, { action: 'cancel' }, { goal: false });
  f.emit({ type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 });
  f.emit({ type: 'chunk', attemptId: 'old', index: 0, chunk: { type: 'reasoning-delta', index: 0, text: '好。'.repeat(80) } });
  assert.equal((await f.report()).fired, 0);
  f.emit({ type: 'chunk', attemptId: 'attempt-1', index: 0, chunk: { type: 'block-end', index: 0,
    block: { type: 'reasoning', text: '现在执行下一步。'.repeat(40) } } });
  await drain();
  assert.equal(f.cancellations.length, 1);
});

test('elapsed budget fires during a stalled first step with no new events', async (t) => {
  const f = await fixture(t, { maxTurnMinutes: 0.0005, action: 'cancel' }, { goal: false });
  f.append('turn/start', { turn: 1 });
  f.append('step/start', { turn: 1, step: 1 });
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(f.cancellations.length, 1);
  assert.match((await f.report()).text, /已运行/);
});

test('ended turns and disposed plugin cannot fire a delayed timeout', async (t) => {
  const f = await fixture(t, { maxTurnMinutes: 0.0005, action: 'cancel' });
  f.append('turn/start', { turn: 1 });
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(f.cancellations.length, 0);
  f.agent.phase.turn = 2;
  f.append('turn/start', { turn: 2 });
  await f.guardFiber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(f.cancellations.length, 0);
});

test('a recent content verdict cannot permanently suppress the independent deadline', async (t) => {
  const f = await fixture(t, { maxTurnMinutes: 0.0005, cooldownMs: 80, action: 'warn' });
  f.append('turn/start', { turn: 1 });
  f.settle('好。'.repeat(80));
  await drain();
  assert.equal((await f.report()).fired, 1);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal((await f.report()).fired, 2);
  assert.match((await f.report()).text, /已运行/);
});

test('reset preserves pending idle compaction and its paused goal', async (t) => {
  let resolveCompact, signal;
  const f = await fixture(t, { autoCompact: true }, { compact(agent, suppliedSignal) {
    assert.equal(agent.phase.kind, 'idle');
    signal = suppliedSignal;
    agent.phase = { kind: 'maintenance' };
    return new Promise((resolve) => { resolveCompact = resolve; });
  } });
  f.settle('好。'.repeat(80));
  await drain();
  assert.equal(f.goals.get(f.agent).phase, 'paused');
  await f.reset();
  f.idle();
  assert.equal(signal.aborted, false);
  resolveCompact({ shadowedTokenCount: 100 });
  await drain();
  assert.equal(f.goals.get(f.agent).phase, 'active');
  assert.equal((await f.report()).compact, '1/0');
});

test('timeout aborts compaction, releases goal and ignores a late completion', async (t) => {
  let resolveCompact, signal;
  const f = await fixture(t, { autoCompact: true, compactTimeoutMs: 20 }, { compact(agent, suppliedSignal) {
    signal = suppliedSignal;
    agent.phase = { kind: 'maintenance' };
    return new Promise((resolve) => { resolveCompact = resolve; });
  } });
  f.settle('好。'.repeat(80));
  await drain();
  f.idle();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(signal.aborted, true);
  assert.equal(f.goals.get(f.agent).phase, 'active');
  resolveCompact({ shadowedTokenCount: 100 });
  await drain();
  assert.equal((await f.report()).compact, '0/1');
});

test('disposal releases a paused goal even if compaction ignores abort', async (t) => {
  const f = await fixture(t, { autoCompact: true, compactTimeoutMs: 0 }, { compact(agent) {
    agent.phase = { kind: 'maintenance' };
    return new Promise(() => {});
  } });
  f.settle('好。'.repeat(80));
  await drain();
  f.idle();
  await f.guardFiber.dispose();
  assert.equal(f.goals.get(f.agent).phase, 'active');
});

test('warn, cancel and resumeGoal=false retain their documented action semantics', async (t) => {
  for (const config of [{ action: 'warn' }, { action: 'cancel' }, { resumeGoal: false }]) {
    const f = await fixture(t, config);
    f.settle('好。'.repeat(80));
    await drain();
    assert.equal(f.cancellations.length, config.action === 'warn' ? 0 : 1);
    f.idle();
    assert.equal(f.goals.get(f.agent).phase, config.action === 'warn' ? 'active' : 'paused');
  }
});

test('a disabled plugin remains observable and can be enabled without reloading', async (t) => {
  const f = await fixture(t, { enabled: false });
  f.settle('好。'.repeat(80));
  await drain();
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.monitor.getSnapshot().config.enabled, false);
  f.monitor.updateConfig({ ...f.monitor.baseConfig, enabled: true });
  f.settle('好。'.repeat(80));
  await drain();
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.monitor.getSnapshot().agents[0].events[0].phase, 'waiting');
});

test('disable cancels queued detection but preserves in-flight goal recovery policy', async (t) => {
  const f = await fixture(t);
  f.settle('好。'.repeat(80));
  f.monitor.updateConfig({ ...f.monitor.baseConfig, enabled: false });
  await drain();
  assert.equal(f.cancellations.length, 0);
  f.monitor.updateConfig(f.monitor.baseConfig);
  f.settle('好。'.repeat(80));
  await drain();
  assert.equal(f.goals.get(f.agent).phase, 'paused');
  f.monitor.updateConfig({ ...f.monitor.baseConfig, enabled: false, resumeGoal: false, action: 'cancel' });
  assert.equal(f.monitor.getSnapshot().agents[0].phase, 'waiting');
  f.idle();
  assert.equal(f.goals.get(f.agent).phase, 'active');
  const row = f.monitor.getSnapshot().agents[0];
  assert.equal(row.phase, 'disabled');
  assert.equal(row.events[0].phase, 'resumed');
  assert.equal(row.events[0].action, 'pause-goal');
});

test('status reports compaction failure separately from successful goal recovery', async (t) => {
  let resolveCompact;
  const f = await fixture(t, { autoCompact: true }, { compact() { return new Promise(resolve => { resolveCompact = resolve; }); } });
  f.append('turn/start', { turn: 1 });
  f.settle('好。'.repeat(80));
  await drain();
  f.idle();
  assert.equal(f.monitor.getSnapshot().agents[0].phase, 'compacting');
  f.monitor.updateConfig({ ...f.monitor.baseConfig, enabled: false, resumeGoal: false });
  resolveCompact(null);
  await drain();
  const row = f.monitor.getSnapshot().agents[0];
  assert.equal(row.events[0].phase, 'failed');
  assert.equal(row.events[0].compaction, 'failed');
  assert.equal(row.events[0].resumed, true);
  assert.equal(f.goals.get(f.agent).phase, 'active');
});

test('snapshots are detached, omit reasoning text and freeze elapsed time at turn end', async (t) => {
  const f = await fixture(t);
  f.append('turn/start', { turn: 1 });
  f.append('step/start', { turn: 1, step: 1 });
  f.settle('DO-NOT-EXPOSE-PRIVATE-REASONING。');
  f.append('turn/end', { turn: 1 });
  const snapshot = f.monitor.getSnapshot();
  assert.doesNotMatch(JSON.stringify(snapshot), /DO-NOT-EXPOSE/);
  snapshot.config.enabled = false;
  snapshot.agents[0].stats.lines = 9876;
  await new Promise(resolve => setTimeout(resolve, 10));
  const after = f.monitor.getSnapshot();
  assert.equal(after.config.enabled, true);
  assert.equal(after.agents[0].stats.lines, 1);
  assert.equal(after.agents[0].elapsedMs, snapshot.agents[0].elapsedMs);
});

test('live threshold changes keep stream evidence and update the active time watchdog', async (t) => {
  const f = await fixture(t, { repeatedRunLimit: 100, perBlockLimit: 1000 }, { goal: false });
  f.append('turn/start', { turn: 1 });
  f.emit({ type: 'start', attemptId: 'stream', turn: 1, step: 1 });
  f.emit({ type: 'chunk', attemptId: 'stream', index: 0, chunk: { type: 'reasoning-delta', index: 0, text: '好。'.repeat(20) } });
  f.monitor.updateConfig({ ...f.monitor.baseConfig, repeatedRunLimit: 21, action: 'cancel' });
  f.emit({ type: 'chunk', attemptId: 'stream', index: 1, chunk: { type: 'reasoning-delta', index: 0, text: '好。' } });
  await drain();
  assert.equal(f.cancellations.length, 1);
  f.monitor.updateConfig({ ...f.monitor.baseConfig, action: 'cancel', maxTurnMinutes: 0.0005 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.cancellations.length, 2);
});

test('renamed command and tool preserve their legacy aliases', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.tools.get('reasoning_monitor_status').execute(), await f.tools.get('guard_status').execute());
  assert.deepEqual(await f.commands.get('monitor').handler({ rawInput: 'status' }), await f.commands.get('guard').handler({ rawInput: 'status' }));
});
