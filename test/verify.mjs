/**
 * 回放验证：用 ~/.dsh/sessions 下的真实会话喂给 chant.js，
 * 观察规则触发情况；没有人工标签，不能由此推断误报率或漏报率。
 *
 * 用法：node test/verify.mjs [会话路径片段]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';
import {
  analyzeReasoningText,
  createGuardState,
  evaluateBlock,
  resolveConfig,
} from '../lib/chant.js';

const SESSION_ROOT = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
if (typeof zlib.zstdDecompressSync !== 'function') {
  throw new Error('当前 Node 不支持 Zstandard 解压，请使用 Node 24 运行历史回放。');
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.startsWith('session') && entry.name.endsWith('.zstd')) out.push(p);
  }
  return out;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = 0;
  while (i >= 0) {
    const at = buf.indexOf(ZSTD_MAGIC, i);
    if (at < 0) break;
    starts.push(at);
    i = at + 4;
  }
  const chunks = [];
  for (let n = 0; n < starts.length; n++) {
    const end = n + 1 < starts.length ? starts[n + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[n], end)));
    } catch {
      /* 跳过损坏帧 */
    }
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 用护栏自身的配置与状态机重放一个会话，冻结时间以便观察触发。 */
function replay(file, cfg) {
  const state = createGuardState();
  let blocks = 0;
  let chant = 0;
  let peak = 0;
  let fired = 0;
  const firstFires = [];

  // 冷却在验证里禁用：我们关心的是"会不会认定退化"，而非"多久报一次"。
  const replayCfg = { ...cfg, cooldownMs: 0 };

  for (const ev of decode(file)) {
    if (ev.type !== 'assistant/message') continue;
    const content = ev.data?.message?.content;
    if (!Array.isArray(content)) continue;
    let text = '';
    for (const block of content) if (block?.type === 'reasoning') text += (block.text ?? '') + '\n';
    if (!text) continue;

    const stats = analyzeReasoningText(text);
    if (!stats.lines) continue;
    blocks++;
    chant += stats.chantLines;
    peak = Math.max(peak, stats.chantLines);

    const verdict = evaluateBlock(state, stats, ev.data?.turn ?? 0, replayCfg, 0);
    if (verdict) {
      fired++;
      if (firstFires.length < 3) {
        firstFires.push(`turn=${verdict.turn} 块咏唱=${stats.chantLines} 占比=${(stats.ratio * 100).toFixed(0)}% :: ${verdict.reasons[0]}`);
      }
    }
  }
  return { blocks, chant, peak, fired, firstFires, density: blocks ? chant / blocks : 0 };
}

const frag = process.argv[2];
const cfg = resolveConfig({});
const files = walk(SESSION_ROOT).filter((f) => (frag ? f.includes(frag) : true));
if (!files.length) {
  console.error('未找到会话');
  process.exit(1);
}

const rows = files.map((file) => ({ file, ...replay(file, cfg) })).filter((r) => r.blocks > 0);
if (!rows.length) throw new Error('没有成功解码的 reasoning，无法评估检测结果。');
rows.sort((a, b) => b.density - a.density);

const LIMIT = cfg.perBlockLimit;
console.log(`阈值：单块 ≥ ${LIMIT} 句 | ${cfg.windowBlocks} 块累计 ≥ ${cfg.windowLimit} | 单 turn ≥ ${cfg.turnLimit} | 占比 ≥ ${cfg.minChantRatio} | 连续同句 ≥ ${cfg.repeatedRunLimit}`);
console.log(`（验证时冷却置 0，只看判定；实机默认冷却 ${cfg.cooldownMs}ms）\n`);
console.log('触发  密度   块数   咏唱句   峰值块  session');
for (const r of rows) {
  const name = path.basename(path.dirname(r.file)).slice(0, 34);
  console.log(
    `${String(r.fired).padStart(4)} ${r.density.toFixed(1).padStart(6)} ${String(r.blocks).padStart(6)} ${String(r.chant).padStart(8)} ${String(r.peak).padStart(7)}  ${name}`
  );
}

const degraded = rows.filter((r) => r.fired > 0);
const clean = rows.filter((r) => r.fired === 0);
console.log(`\n会话总数 ${rows.length}：规则触发 ${degraded.length} 个，未触发 ${clean.length} 个（未经人工标注）。`);

const maxCleanPeak = clean.reduce((a, r) => Math.max(a, r.peak), 0);
console.log(`未触发会话的最大单块咏唱句数 = ${maxCleanPeak}（阈值 ${LIMIT}，余量 ${LIMIT - maxCleanPeak} 句）`);

if (degraded.length) {
  console.log('\n规则触发的会话首批触发点：');
  for (const r of degraded.slice(0, 5)) {
    console.log(`  ${path.basename(path.dirname(r.file)).slice(0, 30)}`);
    for (const f of r.firstFires) console.log(`      ${f}`);
  }
}
