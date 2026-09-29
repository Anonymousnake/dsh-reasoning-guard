import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReasoningText, createReasoningAnalyzer, createGuardState, evaluateBlock,
  previewBlock, resolveConfig, isChantLine, checkBudget } from '../lib/chant.js';

const cfg = resolveConfig({ cooldownMs: 0 });
const verdict = (text) => evaluateBlock(createGuardState(), analyzeReasoningText(text), 1, cfg, 0);

test('wrappers, punctuation, markdown lists and inline phrases are detected', () => {
  for (const text of ['好。', '（好）。', '（好。）', '- 好。', '**OK!**', '【执行】。']) {
    assert.equal(isChantLine(text), true, text);
    assert.ok(verdict(Array(80).fill(text).join('\n')), text);
  }
  assert.ok(verdict('好。'.repeat(1000)));
  assert.ok(verdict('现在开始执行下一步。'.repeat(80)));
  assert.equal(verdict('现在开始执行下一步。'.repeat(29)), null);
});

test('sparse action words and unique substantive sentences do not establish repetition', () => {
  const text = Array.from({ length: 60 }, (_, i) => [
    ...Array.from({ length: 20 }, (_, j) => `第${i}项第${j}个独立检查结果已记录。`), '好。',
  ]).flat().join('\n');
  const stats = analyzeReasoningText(text);
  assert.equal(stats.chantLines, 60);
  assert.equal(stats.maxRun, 1);
  assert.ok(stats.ratio < 0.05);
  assert.equal(verdict(text), null);
  assert.equal(verdict(Array.from({ length: 100 }, (_, i) => `检查项${i}已完成。`).join('')), null);
});

test('a long consecutive run remains detectable inside a large substantive message', () => {
  const prefix = Array.from({ length: 200 }, (_, i) => `独立结果${i}。`).join('');
  assert.ok(verdict(prefix + '好。执行。'.repeat(30)));
});

test('streamed chunk boundaries produce exactly the same final statistics', () => {
  const text = '**（好）。**\n\n- 执行！\n' + '现在开始执行下一步。'.repeat(50) + '尾句';
  for (const size of [1, 2, 7, 31, 1024]) {
    const analyzer = createReasoningAnalyzer();
    for (let i = 0; i < text.length; i += size) analyzer.push(text.slice(i, i + size));
    assert.deepEqual(analyzer.finish(), analyzeReasoningText(text));
  }
  const long = createReasoningAnalyzer();
  for (let i = 0; i < 1000; i++) long.push('实质性内容'.repeat(100));
  long.push('好。');
  assert.equal(long.finish().chantLines, 0, 'overflow cannot turn a long sentence tail into a chant');
});

test('turn transitions discard stale windows and cumulative evidence', () => {
  const state = createGuardState();
  evaluateBlock(state, analyzeReasoningText('好。'.repeat(150)), 1, cfg, 0);
  for (let i = 1; i < 4; i++) {
    assert.equal(evaluateBlock(state, analyzeReasoningText(`独立结果${i}。`), 2, cfg, i), null);
  }
});

test('preview does not double count settled reasoning and retains cooldown', () => {
  const state = createGuardState();
  const stats = analyzeReasoningText('好。'.repeat(80));
  assert.ok(previewBlock(state, stats, 1, cfg, 0));
  assert.equal(state.totalBlocks, 0);
  assert.equal(state.totalChant, 0);
  assert.equal(evaluateBlock(state, stats, 1, cfg, 1, true), null);
  assert.equal(state.totalBlocks, 1);
  assert.equal(state.totalChant, 80);
  assert.equal(state.fired, 1);
  assert.equal(previewBlock(state, stats, 1, resolveConfig({}), 2), null);
});

test('time-only checks do not increment step budget; zero disables budgets', () => {
  const state = createGuardState();
  assert.equal(checkBudget(state, 1, 0, cfg, false), null);
  assert.equal(checkBudget(state, 1, 60 * 60000, cfg, false).steps, 0);
  const disabled = resolveConfig({ maxStepsPerTurn: 0, maxTurnMinutes: 0 });
  assert.equal(checkBudget(state, 1, 1e12, disabled), null);
});
