import z from '@deepseek-ai/schemastery';
import { DEFAULT_CONFIG } from './chant.js';

export const SETTINGS_NAMESPACE = 'reasoning-monitor';
export const STATE_ROUTE = '/dsh-reasoning-monitor/state';

const positive = (key) => z.number().min(1).step(1).default(DEFAULT_CONFIG[key]);
const nonnegative = (key) => z.number().min(0).default(DEFAULT_CONFIG[key]);
export const MonitorSchema = z.object({
  enabled: z.boolean().default(true),
  elevatedBlockLimit: positive('elevatedBlockLimit'),
  perBlockLimit: positive('perBlockLimit'),
  windowBlocks: positive('windowBlocks'),
  windowLimit: positive('windowLimit'),
  turnLimit: positive('turnLimit'),
  minChantRatio: z.number().min(0.001).max(1).default(DEFAULT_CONFIG.minChantRatio),
  repeatedRunLimit: positive('repeatedRunLimit'),
  maxStepsPerTurn: nonnegative('maxStepsPerTurn').step(1),
  maxTurnMinutes: nonnegative('maxTurnMinutes'),
  cooldownMs: nonnegative('cooldownMs'),
  compactTimeoutMs: nonnegative('compactTimeoutMs'),
  action: z.union(['warn', 'pause-goal', 'cancel']).default('pause-goal'),
  autoCompact: z.boolean().default(true),
  resumeGoal: z.boolean().default(true),
  intervene: z.boolean().default(false),
  verbose: z.boolean().default(false),
  reminderText: z.string().default(DEFAULT_CONFIG.reminderText),
  budgetReminderText: z.string().default(DEFAULT_CONFIG.budgetReminderText),
});

const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

/** Read-only status: settings writes use DSH's existing revision-fenced API. */
export function stateHandler(monitor) {
  return (req, res) => {
    let code = 200, value;
    let localHost = false;
    try { localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL('http://' + req.headers.host).hostname); } catch {}
    if (!loopback(req.socket?.remoteAddress) || !localHost || req.headers['sec-fetch-site'] === 'cross-site') {
      code = 403; value = { error: 'Reasoning Monitor status requires a local DSH connection.' };
    } else if (req.method !== 'GET') {
      code = 405; value = { error: 'Method not allowed.' }; res.setHeader('allow', 'GET');
    } else value = monitor.getSnapshot();
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(JSON.stringify(value));
  };
}

export function installSettingsAndWeb(ctx, monitor) {
  // Optional consumers keep the detection engine usable in headless profiles.
  ctx.inject(['settings'], (host) => {
    const scope = host.settings.register(SETTINGS_NAMESPACE, MonitorSchema, { base: monitor.baseConfig, applies: 'live' });
    monitor.updateConfig(scope.get());
    host.on('settings/updated', (namespace, next) => {
      if (namespace === SETTINGS_NAMESPACE) monitor.updateConfig(next);
    });
    host.effect(() => () => monitor.updateConfig(monitor.baseConfig));
  });
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler(monitor) }));
  });
}
