/**
 * 咏唱检测核心（reasoning chant detector）。
 *
 * 背景：部分模型在长任务、反复失败的场景下，reasoning 正文会退化成"行动宣告复读" ——
 * 整段思考只剩「好。」「执行。」「写。」「GO。」「（写）」这类短句，每句独立成段。
 * dsh 的"思考"区以 white-space: pre-wrap 原样渲染，于是视觉上等同死循环。
 *
 * 本模块只做判定，不碰任何 dsh API：纯函数，便于单测与复用。
 *
 * 判定口径刻意保守：整行去掉 markdown 标记、括号、尾部标点后，必须**恰好**等于
 * 一个小集合里的行动词才算一次咏唱。任何带实质内容的长句都不计入。
 */

/**
 * 去掉修饰后仍等于这些词，才算一次咏唱。
 *
 * 词表按实际退化的高频用词收：deepseek-v4.1-flash 出「好。/执行。/写。/GO。」，
 * gemini-3.8-flash-tiered 出「做./OK./Go.」。刻意不收「行 / 可以 / 上 / 冲 / 干」这类
 * 口语里也常见的单字，避免把正常短句算成复读 —— 真正防误报的是阈值，不是词表。
 */
const CHANT_CORES = new Set([
  '好', 'ok', 'OK', 'Ok',
  '执行', '写', '做', '开始', '继续', '实施', '实现', '测试',
  '行动', '立刻', '马上', '立即',
  'go', 'GO', 'Go', 'gogo',
]);

/** 整行原始长度上限：超过这个长度的行一定带有实质内容。 */
const MAX_RAW_LENGTH = 28;
/** 去掉修饰后的核心长度上限。 */
const MAX_CORE_LENGTH = 6;

const MARKUP = /[*_`~#>|]+/g;
const LEADING_WRAPPER = /^[（(【\[「『]+/;
const TRAILING_WRAPPER = /[）)】\]」』]+$/;
const TRAILING_PUNCT = /[。！!.,，、：:;；?？~～\s]+$/;

/**
 * 把一个可能带 markdown 强调、括号、标点的短行归一化成核心词。
 * @param raw 原始行。
 * @returns 归一化后的核心文本；无内容时返回空串。
 */
export function normalizeChantLine(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  text = text.replace(MARKUP, '').trim();
  text = text.replace(LEADING_WRAPPER, '').replace(TRAILING_WRAPPER, '').trim();
  text = text.replace(TRAILING_PUNCT, '').trim();
  return text;
}

/**
 * 判断一行是否是"咏唱行"。
 * @param raw 原始行（未 trim）。
 * @returns 是则 true。
 */
export function isChantLine(raw) {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (!text || text.length > MAX_RAW_LENGTH) return false;
  const core = normalizeChantLine(text);
  if (!core || core.length > MAX_CORE_LENGTH) return false;
  return CHANT_CORES.has(core) || CHANT_CORES.has(core.toLowerCase());
}

/**
 * 统计一段 reasoning 文本的咏唱指标。
 * @param text reasoning 正文。
 * @returns {{lines: number, chantLines: number, ratio: number, maxRun: number, blocks: number}}
 *   lines 为非空行数，ratio 为咏唱行占比，maxRun 为最长连续咏唱行数，
 *   blocks 为被空行分隔出的段落数（UI 会逐段渲染）。
 */
export function analyzeReasoningText(text) {
  const stats = { lines: 0, chantLines: 0, ratio: 0, maxRun: 0, blocks: 0 };
  if (typeof text !== 'string' || !text) return stats;

  let run = 0;
  let sawContentInParagraph = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      // 空行分隔段落：UI 会在此处断开，视觉上的"一屏一条"就是这么来的。
      if (sawContentInParagraph) stats.blocks++;
      sawContentInParagraph = false;
      continue;
    }
    stats.lines++;
    sawContentInParagraph = true;
    if (isChantLine(line)) {
      stats.chantLines++;
      run++;
      if (run > stats.maxRun) stats.maxRun = run;
    } else {
      run = 0;
    }
  }
  if (sawContentInParagraph) stats.blocks++;
  stats.ratio = stats.lines ? stats.chantLines / stats.lines : 0;
  return stats;
}

/** 默认阈值。基于实机扫描：正常会话每块 reasoning 的咏唱行数为 0–3。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  /**
   * 预警档：单块咏唱行数达到此值就记一条 elevated，仍然不处置。
   * 这一档是自我测量逼出来的：正常会话的峰值块多在 5–12 行，而每块末尾带一两句
   * 行动宣告的"正常偏高"思考会落在 20 行上下 —— 值得计数，不值得动会话。
   */
  elevatedBlockLimit: 20,
  /** 单个 reasoning 块的咏唱行数上限。 */
  perBlockLimit: 60,
  /** 滑动窗口长度（块数）。 */
  windowBlocks: 3,
  /** 窗口内累计咏唱行数上限。 */
  windowLimit: 120,
  /** 单个 turn 内累计咏唱行数上限。 */
  turnLimit: 600,
  /**
   * 单 turn 步数预算 —— 这一档才是治本的那一档。
   *
   * 实机数据：正常会话的单轮步数落在 5–42；失控会话跑到 130 步、耗时 1 小时 27 分。
   * 关键在于那 130 步**不是循环**（96 种不同命令、98% 的步骤都有新信息），
   * 而是在一个没有验收标准的难题上无限穷举。咏唱是症状，没有预算才是病根。
   * 0 表示禁用。
   */
  maxStepsPerTurn: 60,
  /** 单 turn 时长预算（分钟）。0 表示禁用。 */
  maxTurnMinutes: 60,
  /** 两次触发之间的冷却，避免刷屏。 */
  cooldownMs: 30000,
  /**
   * 触发后的动作：warn 仅告警 | pause-goal 暂停 goal | cancel 取消当前 turn。
   *
   * 默认 warn 是刻意的。goal-round-driver 在收到**宿主发起**的 pause 时会执行
   * `agent.cancel({kind:"user"})`，也就是暂停 goal 必然中止正在运行的 turn，
   * 而且 UI 会把这记成"用户中断"。配合 autoCompact 时，warn 已经能自愈（清掉复读
   * 痕迹），代价是不再切断 goal 的续命链 —— 想要更硬的手段再显式改这一档。
   *
   * pause-goal 档不是终局：压缩完成后会自动 resume（见 resumeGoal），驱动在
   * agent idle 时自动排下一轮，自动化继续；只有 cancel 档会留下暂停态。
   */
  action: 'warn',
  /**
   * 等待压缩落定的上限（毫秒），0 表示不限时。
   *
   * 压缩要调一次模型生成摘要，大上下文可能超过冷却期。到点后继续后续处置，
   * 压缩本身仍在后台落定并计入统计。同一 agent 的压缩串行：在飞时的新触发
   * 等它落定而不是叠加 —— 压缩实现在摘要期做 surface 校验，并发必然失败一方。
   */
  compactTimeoutMs: 120000,
  /**
   * pause-goal 档在压缩完成后自动 resume goal。
   *
   * 暂停的意义是让压缩趁 turn 活着跑完、并让驱动的僵尸 attempt 保护失效
   * （pause/resume 各推进一次 revision，旧 attempt 的 revision 对不上），
   * 恢复后驱动在 agent idle 时自动排下一轮 —— 自动化不因护栏中断。
   */
  resumeGoal: true,
  /**
   * 越线后是否自动压缩一次上下文。
   *
   * 实测依据：失控会话里 2 次可比较的自动压缩，压缩前 4 块平均咏唱 4585 / 20.8 行，
   * 压缩后 4 块降到 2.5 / 0.8 行（均值 2303 → 1.6），摘要内咏唱式短词残留为 0。
   * 压缩清掉的是复读痕迹，留下的是任务事实 —— 它同时打断上下文过长与自我模仿。
   */
  autoCompact: true,
  /** 是否在下一步注入收敛提醒（需要 @deepseek-ai/dsh-llm，缺失时静默降级）。 */
  intervene: false,
  /** 会话内提醒文本。 */
  reminderText:
    '检测到你的思考正在退化成复读：reasoning 里「好。/执行。/写。/GO。」这类行动宣告已占绝大多数行。'
    + '停止复述意图，不要重复已经失败的方案。直接执行一个具体的工具调用，或明确说明为何无法推进。',
  /** 预算触发（step/start 档）的会话内提醒文本 —— 病灶是无限穷举而非复读。 */
  budgetReminderText:
    '检测到当前 turn 已超出步数/时长预算：这是没有验收标准的无限穷举，不是推进。'
    + '停止继续尝试新方法，先明确本 turn 的完成标准；若无法达成，直接说明原因并收尾。',
  /** 输出调试日志。 */
  verbose: false,
};

/** 每个 agent 的独立跟踪状态。 */
export function createGuardState() {
  return {
    window: [],
    turn: -1,
    turnChant: 0,
    turnBlocks: 0,
    lastFiredAt: 0,
    fired: 0,
    totalChant: 0,
    totalBlocks: 0,
    peakBlock: 0,
    elevatedBlocks: 0,
    budget: { turn: -1, steps: 0, startedAt: 0 },
    lastVerdict: null,
    pendingIntervention: false,
    compacted: 0,
    compactFailed: 0,
  };
}

/**
 * 把一个新的 reasoning 块并入统计并按阈值判定。
 * @param state 该 agent 的跟踪状态（原地更新）。
 * @param stats analyzeReasoningText 的结果。
 * @param turn 当前 turn 号。
 * @param config 已合并的配置。
 * @param now 当前时间戳（ms）。
 * @returns 触发时的判决对象；未触发返回 null。
 */
export function evaluateBlock(state, stats, turn, config, now) {
  state.totalBlocks++;
  state.totalChant += stats.chantLines;
  if (stats.chantLines > state.peakBlock) state.peakBlock = stats.chantLines;

  state.window.push(stats.chantLines);
  while (state.window.length > Math.max(1, config.windowBlocks)) state.window.shift();

  if (state.turn !== turn) {
    state.turn = turn;
    state.turnChant = 0;
    state.turnBlocks = 0;
  }
  state.turnChant += stats.chantLines;
  state.turnBlocks++;

  const reasons = [];
  if (stats.chantLines >= config.perBlockLimit) {
    reasons.push(`单块咏唱 ${stats.chantLines} 行 ≥ ${config.perBlockLimit}`);
  }
  const windowSum = state.window.reduce((a, b) => a + b, 0);
  if (state.window.length >= config.windowBlocks && windowSum >= config.windowLimit) {
    reasons.push(`${state.window.length} 块累计咏唱 ${windowSum} 行 ≥ ${config.windowLimit}`);
  }
  if (state.turnChant >= config.turnLimit) {
    reasons.push(`本 turn 累计咏唱 ${state.turnChant} 行 ≥ ${config.turnLimit}`);
  }
  if (!reasons.length) return null;

  if (now - state.lastFiredAt < config.cooldownMs) return null;
  state.lastFiredAt = now;
  state.fired++;

  const verdict = {
    reasons,
    stats,
    windowSum,
    turnChant: state.turnChant,
    turnBlocks: state.turnBlocks,
    fired: state.fired,
    turn,
  };
  state.lastVerdict = verdict;
  state.pendingIntervention = true;
  return verdict;
}

/**
 * 单 turn 预算检查：步数与时长。每收到一个 `step/start` 调用一次。
 *
 * 这是治本的那一档：咏唱检测抓的是"已经开始退化"，预算抓的是"正在无限穷举"。
 * 返回超支原因；未超支返回 null。两个维度各自可用 0 禁用。
 */
export function checkBudget(state, turn, now, config) {
  const budget = state.budget;
  if (budget.turn !== turn) {
    budget.turn = turn;
    budget.steps = 0;
    budget.startedAt = now;
  }
  budget.steps++;

  const reasons = [];
  if (config.maxStepsPerTurn > 0 && budget.steps > config.maxStepsPerTurn) {
    reasons.push(`本 turn 步数 ${budget.steps} > ${config.maxStepsPerTurn}`);
  }
  // startedAt 在上面的分支里必定被赋值，这里不做 falsy 判断 —— 时间戳 0 是合法值。
  const minutes = (now - budget.startedAt) / 60000;
  if (config.maxTurnMinutes > 0 && minutes > config.maxTurnMinutes) {
    reasons.push(`本 turn 已运行 ${minutes.toFixed(1)} 分钟 > ${config.maxTurnMinutes}`);
  }
  if (!reasons.length) return null;
  return { reasons, stats: null, turn, steps: budget.steps, minutes };
}

/** 合并用户配置与默认值，并对关键字段做类型兜底。 */
export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  const num = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const budgetNum = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
  cfg.elevatedBlockLimit = num(cfg.elevatedBlockLimit, DEFAULT_CONFIG.elevatedBlockLimit);
  cfg.maxStepsPerTurn = budgetNum(cfg.maxStepsPerTurn, DEFAULT_CONFIG.maxStepsPerTurn);
  cfg.maxTurnMinutes = budgetNum(cfg.maxTurnMinutes, DEFAULT_CONFIG.maxTurnMinutes);
  cfg.perBlockLimit = num(cfg.perBlockLimit, DEFAULT_CONFIG.perBlockLimit);
  cfg.windowBlocks = Math.max(1, Math.round(num(cfg.windowBlocks, DEFAULT_CONFIG.windowBlocks)));
  cfg.windowLimit = num(cfg.windowLimit, DEFAULT_CONFIG.windowLimit);
  cfg.turnLimit = num(cfg.turnLimit, DEFAULT_CONFIG.turnLimit);
  cfg.cooldownMs = Number.isFinite(cfg.cooldownMs) && cfg.cooldownMs >= 0 ? cfg.cooldownMs : DEFAULT_CONFIG.cooldownMs;
  cfg.compactTimeoutMs = budgetNum(cfg.compactTimeoutMs, DEFAULT_CONFIG.compactTimeoutMs);
  cfg.resumeGoal = cfg.resumeGoal !== false;
  cfg.budgetReminderText =
    typeof cfg.budgetReminderText === 'string' && cfg.budgetReminderText
      ? cfg.budgetReminderText
      : DEFAULT_CONFIG.budgetReminderText;
  cfg.action = ['warn', 'pause-goal', 'cancel'].includes(cfg.action) ? cfg.action : DEFAULT_CONFIG.action;
  cfg.intervene = cfg.intervene === true;
  cfg.autoCompact = cfg.autoCompact !== false;
  cfg.enabled = cfg.enabled !== false;
  cfg.verbose = cfg.verbose === true;
  return cfg;
}
