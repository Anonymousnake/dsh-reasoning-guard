/** Pure, incremental reasoning repetition detection. No dsh dependencies. */
const CHANT_CORES = new Set([
  '好', 'ok', '执行', '写', '做', '开始', '继续', '实施', '实现', '测试',
  '行动', '立刻', '马上', '立即', 'go', 'gogo',
]);
const MAX_RAW_LENGTH = 256;
const MAX_REPEAT_LENGTH = 80;
const MARKUP = /[*_\x60~#>|]+/g;
const EDGE = /^[\s（(【\[「『"'“”‘’。！!.,，、：:;；?？~～）)】\]」』]+|[\s（(【\[「『"'“”‘’。！!.,，、：:;；?？~～）)】\]」』]+$/g;

export function normalizeChantLine(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(MARKUP, '').replace(/^\s*(?:[-+•]\s+|\d+[.)、]\s+)/, '')
    .replace(EDGE, '').trim();
}

export function isChantLine(raw) {
  if (typeof raw !== 'string' || raw.trim().length > MAX_RAW_LENGTH) return false;
  return CHANT_CORES.has(normalizeChantLine(raw).toLowerCase());
}

/**
 * Count sentence/newline-delimited units, including inline "好。好。".
 * Keep only a bounded unfinished unit; a long stream never accumulates its text.
 * lines/chantLines retain the public field names but now count short units.
 */
export function createReasoningAnalyzer() {
  const stats = { lines: 0, chantLines: 0, ratio: 0, maxRun: 0, blocks: 0, maxRepeatRun: 0 };
  let pending = '', overflow = false, run = 0, previous = '', repeatRun = 0;
  let paragraph = false, lineContent = false;
  function commit() {
    const core = normalizeChantLine(pending);
    if (!core && !overflow) { pending = ''; return; }
    stats.lines++;
    paragraph = true;
    if (!overflow && isChantLine(pending)) {
      stats.chantLines++;
      stats.maxRun = Math.max(stats.maxRun, ++run);
    } else run = 0;
    const candidate = !overflow && core.length <= MAX_REPEAT_LENGTH && /\p{L}/u.test(core)
      ? core.toLowerCase() : '';
    repeatRun = candidate && candidate === previous ? repeatRun + 1 : candidate ? 1 : 0;
    previous = candidate;
    stats.maxRepeatRun = Math.max(stats.maxRepeatRun, repeatRun);
    pending = '';
    overflow = false;
  }
  function snapshot() {
    return { ...stats, ratio: stats.lines ? stats.chantLines / stats.lines : 0,
      blocks: stats.blocks + Number(paragraph) };
  }
  return {
    push(text) {
      if (typeof text !== 'string') return;
      for (const char of text) {
        if (/[。！？!?；;.\n]/.test(char)) {
          commit();
          if (char === '\n') {
            if (!lineContent && paragraph) { stats.blocks++; paragraph = false; }
            lineContent = false;
          } else lineContent = true;
        } else {
          if (char.trim()) lineContent = true;
          if (pending.length < MAX_RAW_LENGTH) pending += char;
          else overflow = true;
        }
      }
    },
    snapshot,
    finish() { commit(); return snapshot(); },
  };
}

export function analyzeReasoningText(text) {
  const analyzer = createReasoningAnalyzer();
  analyzer.push(text);
  return analyzer.finish();
}

export const DEFAULT_CONFIG = {
  enabled: true,
  elevatedBlockLimit: 20,
  perBlockLimit: 60,
  windowBlocks: 3,
  windowLimit: 120,
  turnLimit: 600,
  // Sparse action words in otherwise substantive reasoning do not establish a loop.
  minChantRatio: 0.5,
  // Identical short sentences outside the vocabulary must repeat consecutively.
  repeatedRunLimit: 30,
  maxStepsPerTurn: 60,
  maxTurnMinutes: 60,
  cooldownMs: 30000,
  action: 'pause-goal',
  compactTimeoutMs: 120000,
  resumeGoal: true,
  autoCompact: true,
  intervene: false,
  reminderText: '检测到 reasoning 中持续重复的短句。请停止复述意图，检查已有结果，执行有依据的下一步；无法推进时说明原因。',
  budgetReminderText: '当前 turn 已达到配置的步数或时长预算。请核对完成标准和已有进展，收尾并说明尚未完成的工作。',
  verbose: false,
};

export function createGuardState() {
  return {
    window: [], turn: -1, turnChant: 0, turnLines: 0, turnBlocks: 0,
    lastFiredAt: -Infinity, fired: 0, totalChant: 0, totalBlocks: 0, peakBlock: 0,
    elevatedBlocks: 0, budget: { turn: -1, steps: 0, startedAt: 0 },
    lastVerdict: null, pendingIntervention: false, compacted: 0, compactFailed: 0,
  };
}

export function resetDetection(state, turn = -1) {
  state.window = [];
  state.turn = turn;
  state.turnChant = 0;
  state.turnLines = 0;
  state.turnBlocks = 0;
}

export function recordVerdict(state, verdict, now, config) {
  if (now - state.lastFiredAt < config.cooldownMs) return null;
  state.lastFiredAt = now;
  state.fired++;
  const result = { ...verdict, fired: state.fired };
  state.lastVerdict = result;
  state.pendingIntervention = true;
  return result;
}

/** Commit exactly one settled message. Streaming uses a separate preview copy. */
export function evaluateBlock(state, stats, turn, config, now, suppress = false) {
  if (state.turn !== turn) resetDetection(state, turn);
  state.totalBlocks++;
  state.totalChant += stats.chantLines;
  state.peakBlock = Math.max(state.peakBlock, stats.chantLines);
  state.window.push({ chant: stats.chantLines, lines: stats.lines });
  while (state.window.length > config.windowBlocks) state.window.shift();
  state.turnChant += stats.chantLines;
  state.turnLines += stats.lines;
  state.turnBlocks++;
  if (suppress) return null;

  const reasons = [];
  if (stats.chantLines >= config.perBlockLimit
      && (stats.ratio >= config.minChantRatio || stats.maxRun >= config.perBlockLimit)) {
    reasons.push('单块重复短句 ' + stats.chantLines + ' ≥ ' + config.perBlockLimit);
  }
  if (stats.maxRepeatRun >= config.repeatedRunLimit) {
    reasons.push('同一句连续重复 ' + stats.maxRepeatRun + ' ≥ ' + config.repeatedRunLimit);
  }
  const windowSum = state.window.reduce((n, row) => n + row.chant, 0);
  const windowLines = state.window.reduce((n, row) => n + row.lines, 0);
  if (state.window.length >= config.windowBlocks && windowSum >= config.windowLimit
      && windowSum / Math.max(1, windowLines) >= config.minChantRatio) {
    reasons.push(state.window.length + ' 块累计重复短句 ' + windowSum + ' ≥ ' + config.windowLimit);
  }
  if (state.turnChant >= config.turnLimit
      && state.turnChant / Math.max(1, state.turnLines) >= config.minChantRatio) {
    reasons.push('本 turn 累计重复短句 ' + state.turnChant + ' ≥ ' + config.turnLimit);
  }
  if (!reasons.length) return null;
  return recordVerdict(state, { reasons, stats, windowSum, turnChant: state.turnChant,
    turnBlocks: state.turnBlocks, turn }, now, config);
}

/** Evaluate live text without committing its counts a second time at settlement. */
export function previewBlock(state, stats, turn, config, now) {
  const preview = { ...state, window: [...state.window] };
  const verdict = evaluateBlock(preview, stats, turn, config, now);
  return verdict ? recordVerdict(state, verdict, now, config) : null;
}

/** step=false checks elapsed time without inventing another step. */
export function checkBudget(state, turn, now, config, step = true) {
  const budget = state.budget;
  if (budget.turn !== turn) {
    budget.turn = turn;
    budget.steps = 0;
    budget.startedAt = now;
  }
  if (step) budget.steps++;
  const reasons = [];
  if (config.maxStepsPerTurn > 0 && budget.steps > config.maxStepsPerTurn) {
    reasons.push('本 turn 步数 ' + budget.steps + ' > ' + config.maxStepsPerTurn);
  }
  const minutes = (now - budget.startedAt) / 60000;
  if (config.maxTurnMinutes > 0 && minutes >= config.maxTurnMinutes) {
    reasons.push('本 turn 已运行 ' + minutes.toFixed(1) + ' 分钟 ≥ ' + config.maxTurnMinutes);
  }
  return reasons.length ? { reasons, stats: null, turn, steps: budget.steps, minutes } : null;
}

export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const nonnegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  for (const key of ['elevatedBlockLimit', 'perBlockLimit', 'windowLimit', 'turnLimit', 'repeatedRunLimit']) {
    cfg[key] = positive(cfg[key], DEFAULT_CONFIG[key]);
  }
  for (const key of ['maxStepsPerTurn', 'maxTurnMinutes', 'cooldownMs', 'compactTimeoutMs']) {
    cfg[key] = nonnegative(cfg[key], DEFAULT_CONFIG[key]);
  }
  cfg.windowBlocks = Math.max(1, Math.round(positive(cfg.windowBlocks, DEFAULT_CONFIG.windowBlocks)));
  cfg.minChantRatio = Number.isFinite(cfg.minChantRatio) && cfg.minChantRatio > 0 && cfg.minChantRatio <= 1
    ? cfg.minChantRatio : DEFAULT_CONFIG.minChantRatio;
  for (const key of ['reminderText', 'budgetReminderText']) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) cfg[key] = DEFAULT_CONFIG[key];
  }
  cfg.action = ['warn', 'pause-goal', 'cancel'].includes(cfg.action) ? cfg.action : DEFAULT_CONFIG.action;
  for (const key of ['enabled', 'autoCompact', 'resumeGoal']) cfg[key] = cfg[key] !== false;
  for (const key of ['intervene', 'verbose']) cfg[key] = cfg[key] === true;
  return cfg;
}
