import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import * as monitorPlugin from '../lib/index.js';
import { stateHandler } from '../lib/settings.js';

const drain = () => new Promise(resolve => setImmediate(resolve));

test('real settings preserve base values, validate patches, fence revisions and reload stored values', async (t) => {
  const document = { 'reasoning-monitor': { repeatedRunLimit: 44 } };
  class MemorySettings extends SettingsProvider {
    writable = true;
    async load() { return structuredClone(document); }
    async persist(ns, value) { document[ns] = structuredClone(value); }
  }
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('agents', { list: () => [] });
  ctx.provide('tools', { register() {} });
  ctx.plugin(MemorySettings);
  const config = { perBlockLimit: 88 };
  let fiber = ctx.plugin(monitorPlugin, config);
  await drain(); await drain();
  const settings = ctx.get('settings');
  let monitor = ctx.get('reasoningMonitor');
  assert.equal(monitor.getSnapshot().config.repeatedRunLimit, 44);
  assert.equal(monitor.getSnapshot().config.perBlockLimit, 88);
  const revision = settings.describe({ redactSecrets: true })[0].revision;
  await settings.update('reasoning-monitor', { enabled: false }, revision);
  assert.equal(monitor.getSnapshot().config.enabled, false);
  assert.equal(document['reasoning-monitor'].repeatedRunLimit, 44, 'partial write preserves unrelated fields');
  await assert.rejects(settings.update('reasoning-monitor', { verbose: true }, revision), { code: 'SETTINGS_CONFLICT' });
  await assert.rejects(settings.update('reasoning-monitor', { repeatedRunLimit: -1 }));
  await assert.rejects(settings.update('reasoning-monitor', { minChantRatio: 0 }));
  await assert.rejects(settings.update('reasoning-monitor', { action: 'unknown' }));
  await fiber.dispose();
  fiber = ctx.plugin(monitorPlugin, config);
  await drain(); await drain();
  monitor = ctx.get('reasoningMonitor');
  assert.equal(monitor.getSnapshot().config.enabled, false);
  assert.equal(monitor.getSnapshot().config.repeatedRunLimit, 44);
  await settings.update('reasoning-monitor', { enabled: true });
  assert.equal(monitor.getSnapshot().config.enabled, true);
});

test('status endpoint is read-only and restricted to local same-site requests', () => {
  const handler = stateHandler({ getSnapshot: () => ({ version: 1, agents: [] }) });
  function call(changes = {}) {
    const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }, ...changes };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
    handler(req, res); return res;
  }
  assert.equal(call().statusCode, 200);
  assert.equal(call().headers['cache-control'], 'no-store');
  assert.equal(call({ method: 'POST' }).statusCode, 405);
  assert.equal(call({ socket: { remoteAddress: '192.0.2.1' } }).statusCode, 403);
  assert.equal(call({ headers: { host: 'attacker.example:3080' } }).statusCode, 403);
  assert.equal(call({ headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' } }).statusCode, 403);
});
