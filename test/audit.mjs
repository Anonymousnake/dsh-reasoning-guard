/**
 * 审计：列出某个会话里被判为"咏唱"的行及其频次，
 * 用来判断判定规则是否过度匹配。
 *
 * 用法：node test/audit.mjs <会话路径片段>
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isChantLine, normalizeChantLine, analyzeReasoningText } from '../lib/chant.js';

const SESSION_ROOT = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('请使用支持 Zstandard 的 Node 24 运行审计。');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
    } catch {}
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

const frag = process.argv[2];
const file = walk(SESSION_ROOT).find((f) => f.includes(frag));
if (!file) {
  console.error('未找到会话', frag);
  process.exit(1);
}

const hits = new Map();
const cores = new Map();
let total = 0;
let matched = 0;
let maxRepeatRun = 0;

for (const ev of decode(file)) {
  if (ev.type !== 'assistant/message') continue;
  for (const block of ev.data?.message?.content ?? []) {
    if (block?.type !== 'reasoning') continue;
    maxRepeatRun = Math.max(maxRepeatRun, analyzeReasoningText(block.text).maxRepeatRun);
    for (const raw of (block.text ?? '').split(/[。！？!?；;.\n]/)) {
      const line = raw.trim();
      if (!normalizeChantLine(line)) continue;
      total++;
      if (!isChantLine(line)) continue;
      matched++;
      hits.set(line, (hits.get(line) ?? 0) + 1);
      const core = normalizeChantLine(line);
      cores.set(core, (cores.get(core) ?? 0) + 1);
    }
  }
}

console.log(`会话 ${path.basename(path.dirname(file))}`);
console.log(`非空短句 ${total}，词表匹配 ${matched} 句（${(total ? (matched / total) * 100 : 0).toFixed(1)}%），同句最长连续重复 ${maxRepeatRun} 次\n`);

console.log('== 原始行 top 30 ==');
for (const [line, count] of [...hits].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(String(count).padStart(6), JSON.stringify(line.slice(0, 50)));
}

console.log('\n== 归一化核心词 top 30 ==');
for (const [core, count] of [...cores].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(String(count).padStart(6), JSON.stringify(core));
}
