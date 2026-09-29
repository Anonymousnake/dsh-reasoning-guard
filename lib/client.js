/* DSH Web client: native settings section and a session-scoped input dock. */
window.__ModuleLoader__.load({
  id: 'dsh-reasoning-monitor',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const NS = 'reasoning-monitor';
    const ROUTE = '/dsh-reasoning-monitor/state';
    const messages = {
      zh: {
        name: '思考监控', status: '状态', settings: '设置', enabled: '启用思考监控',
        scope: '应用到此 dsh 实例的全部会话。设置自动保存；正在执行的处置按触发时策略完成。',
        action: '检测到异常时', 'action.pause-goal': '暂停目标并中断生成', 'action.warn': '仅告警，不中断', 'action.cancel': '中断生成并保持暂停',
        'hint.pause-goal': '有活动目标时暂停目标并中断生成；没有活动目标时等待本轮自然结束。',
        'hint.warn': '不中断当前生成；开启自动压缩时，等待本轮自然结束后压缩。',
        'hint.cancel': '无论是否有活动目标都中断生成；已暂停的目标不自动恢复。',
        autoCompact: '自动压缩上下文', resumeGoal: '处置完成后恢复目标', advanced: '高级设置',
        repeatedRunLimit: '相同短句连续重复上限', perBlockLimit: '单块行动短句上限', minChantRatio: '最低行动短句占比',
        windowBlocks: '滑动窗口长度', windowLimit: '窗口内行动短句上限', turnLimit: '单轮行动短句上限',
        elevatedBlockLimit: '仅计数的预警阈值', maxStepsPerTurn: '单轮步数上限', maxTurnMinutes: '单轮时长上限',
        cooldownMs: '处置冷却时间', compactTimeoutMs: '压缩超时', intervene: '下一步附加收敛提醒', verbose: '详细日志',
        zero: '步数、时长、压缩超时设为 0 表示不限；冷却设为 0 表示不限制触发间隔。',
        times: '次', sentences: '句', blocks: '块', steps: '步', minutes: '分钟', seconds: '秒',
        sessions: '运行中的会话', triggers: '累计触发', compactions: '压缩成功 / 失败', recent: '最近处置',
        empty: '尚无处置记录', memory: '仅显示本次插件运行中保留的最近记录；不包含思考原文。',
        connection: '连接中断', loading: '连接中…', unavailable: '配置不可用', readonly: '当前连接不支持保存设置',
        saveFailed: '保存失败', saving: '保存中…', saved: '已保存', updated: '更新于',
        'phase.monitoring': '监测中', 'phase.idle': '待机', 'phase.waiting-data': '等待新事件',
        'phase.disabled': '已关闭', 'phase.queued': '准备处置', 'phase.waiting': '等待本轮结束',
        'phase.compacting': '压缩中', 'phase.resumed': '已恢复目标', 'phase.paused': '目标已暂停',
        'phase.cancelled': '已中断生成', 'phase.warned': '已告警', 'phase.failed': '处置存在异常', 'phase.compacted': '已压缩',
        turn: '轮次', longestRepeat: '最近块最长连续重复', stepCount: '本轮步数', elapsed: '本轮用时',
        limit: '上限', details: '详情', reason: '触发依据', result: '处理结果',
        cancelled: '已中断生成', paused: '已暂停目标', resumed: '已恢复目标',
        'compact.succeeded': '压缩成功', 'compact.failed': '压缩未成功', 'compact.timeout': '压缩超时，已请求取消',
        'compact.unavailable': '压缩服务不可用', 'compact.disabled': '未启用压缩', 'compact.waiting': '等待压缩',
        'error.pause-failed': '目标暂停失败', 'error.cancel-failed': '中断失败', 'error.resume-failed': '目标恢复失败，请手动检查',
        'error.compact-failed': '压缩失败或没有可压缩范围', 'error.compact-timeout': '压缩超时', 'error.compact-unavailable': '压缩服务不可用',
        settingsPath: '配置位置：设置 → 思考监控', unlimited: '不限', stopped: '新检测已关闭，已有处置仍在完成',
        observed: '开始接收事件后显示统计；不会回放历史思考。',
      },
      en: {
        name: 'Reasoning Monitor', status: 'Status', settings: 'Settings', enabled: 'Enable Reasoning Monitor',
        scope: 'Applies to all sessions in this DSH instance. Changes save automatically; in-flight actions finish with their original policy.',
        action: 'When a limit is reached', 'action.pause-goal': 'Pause goal and interrupt', 'action.warn': 'Warn without interrupting', 'action.cancel': 'Interrupt and keep paused',
        'hint.pause-goal': 'Pauses an active goal and interrupts generation. Without an active goal, waits for the turn to end naturally.',
        'hint.warn': 'Leaves generation running. If automatic compaction is enabled, compacts after the turn ends naturally.',
        'hint.cancel': 'Interrupts generation with or without an active goal. Paused goals are not resumed automatically.',
        autoCompact: 'Compact context automatically', resumeGoal: 'Resume goal after handling', advanced: 'Advanced settings',
        repeatedRunLimit: 'Identical phrase repetition limit', perBlockLimit: 'Action phrases per block', minChantRatio: 'Minimum action-phrase ratio',
        windowBlocks: 'Window size', windowLimit: 'Action phrases per window', turnLimit: 'Action phrases per turn',
        elevatedBlockLimit: 'Count-only warning threshold', maxStepsPerTurn: 'Steps per turn', maxTurnMinutes: 'Time per turn',
        cooldownMs: 'Action cooldown', compactTimeoutMs: 'Compaction timeout', intervene: 'Add a reminder before the next step', verbose: 'Verbose logging',
        zero: 'Zero disables step, time, and compaction time limits. Zero cooldown permits consecutive triggers.',
        times: 'times', sentences: 'phrases', blocks: 'blocks', steps: 'steps', minutes: 'min', seconds: 'sec',
        sessions: 'Running sessions', triggers: 'Total triggers', compactions: 'Compactions: succeeded / failed', recent: 'Recent actions',
        empty: 'No actions recorded', memory: 'Recent records from this plugin run only; reasoning text is never included.',
        connection: 'Disconnected', loading: 'Connecting…', unavailable: 'Settings unavailable', readonly: 'This connection cannot save settings',
        saveFailed: 'Save failed', saving: 'Saving…', saved: 'Saved', updated: 'Updated',
        'phase.monitoring': 'Monitoring', 'phase.idle': 'Idle', 'phase.waiting-data': 'Waiting for new events',
        'phase.disabled': 'Disabled', 'phase.queued': 'Preparing action', 'phase.waiting': 'Waiting for turn end',
        'phase.compacting': 'Compacting', 'phase.resumed': 'Goal resumed', 'phase.paused': 'Goal paused',
        'phase.cancelled': 'Generation interrupted', 'phase.warned': 'Warning recorded', 'phase.failed': 'Action needs attention', 'phase.compacted': 'Compacted',
        turn: 'Turn', longestRepeat: 'Longest repetition in latest block', stepCount: 'Steps this turn', elapsed: 'Time this turn',
        limit: 'limit', details: 'Details', reason: 'Trigger evidence', result: 'Result',
        cancelled: 'Generation interrupted', paused: 'Goal paused', resumed: 'Goal resumed',
        'compact.succeeded': 'Compaction succeeded', 'compact.failed': 'Compaction did not succeed', 'compact.timeout': 'Compaction timed out; cancellation requested',
        'compact.unavailable': 'Compaction service unavailable', 'compact.disabled': 'Compaction disabled', 'compact.waiting': 'Waiting for compaction',
        'error.pause-failed': 'Could not pause goal', 'error.cancel-failed': 'Could not interrupt generation', 'error.resume-failed': 'Could not resume goal; check manually',
        'error.compact-failed': 'Compaction failed or nothing could be compacted', 'error.compact-timeout': 'Compaction timed out', 'error.compact-unavailable': 'Compaction service unavailable',
        settingsPath: 'Configure in Settings → Reasoning Monitor', unlimited: 'unlimited', stopped: 'New detection is disabled; an earlier action is still finishing',
        observed: 'Statistics begin with new events; historical reasoning is not replayed.',
      },
    };

    // All mounted surfaces share one request, one timer, and one snapshot.
    function createStatusStore() {
      let snapshot = { data: null, error: '', loading: true };
      let timer, controller, stopped = false;
      const listeners = new Set();
      const publish = next => { snapshot = next; listeners.forEach(fn => fn()); };
      async function refresh() {
        if (stopped || !listeners.size || document.hidden || controller) return;
        clearTimeout(timer);
        const request = new AbortController(); controller = request;
        const timeout = setTimeout(() => request.abort(), 8000);
        try {
          const response = await fetch(ROUTE, { cache: 'no-store', signal: request.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          if (data.version !== 1 || !data.config || !Array.isArray(data.agents)) throw new Error('Invalid status response');
          if (!stopped && controller === request && listeners.size) publish({ data, error: '', loading: false });
        } catch (error) {
          if (!stopped && controller === request && listeners.size && !document.hidden) {
            publish({ data: snapshot.data, error: String(error.message || error), loading: false });
          }
        } finally {
          clearTimeout(timeout);
          if (controller === request) controller = null;
          if (!stopped && listeners.size && !document.hidden) timer = setTimeout(refresh, 2000);
        }
      }
      function suspend() { clearTimeout(timer); const request = controller; controller = null; request?.abort(); }
      function visibility() { if (document.hidden) suspend(); else refresh(); }
      return {
        getSnapshot: () => snapshot,
        subscribe(fn) {
          listeners.add(fn);
          if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); refresh(); }
          return () => { listeners.delete(fn); if (!listeners.size) { suspend(); document.removeEventListener('visibilitychange', visibility); } };
        },
        refresh,
        dispose() { stopped = true; suspend(); listeners.clear(); document.removeEventListener('visibilitychange', visibility); },
      };
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      const locale = ctx.get('locale');
      if (locale) ctx.effect(() => {
        const disposers = Object.entries(messages).map(([lang, dict]) => locale.register(NS, lang, dict));
        return () => disposers.forEach(dispose => dispose());
      });
      const t = locale?.bind(NS) ?? (key => messages.zh[key] ?? key);
      const scope = ctx.get('settingsScope').bind({ namespace: NS });
      const store = createStatusStore();
      ctx.effect(() => () => store.dispose());
      const styles = {
        panel: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
        row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px 16px', minHeight: 32 },
        muted: { color: 'var(--dsw-alias-label-secondary)' },
        small: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px', minWidth: 0, overflowWrap: 'anywhere' },
        badge: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 16, padding: '1px 9px', fontSize: 12 },
        heading: { margin: '12px 0 0', fontSize: 13, fontWeight: 600 },
        input: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', padding: '5px 8px', maxWidth: '100%', minWidth: 0 },
        check: { width: 16, height: 16, accentColor: 'var(--dsw-alias-label-primary)' },
        error: { color: 'var(--dsw-state-error-primary)', fontSize: 12, overflowWrap: 'anywhere' },
        summary: { cursor: 'pointer', overflowWrap: 'anywhere', padding: '5px 0' },
      };
      function useLocale() {
        const [, bump] = React.useReducer(n => n + 1, 0);
        React.useEffect(() => locale?.subscribe(() => bump()), []);
      }
      function useStatus() { return React.useSyncExternalStore(store.subscribe, store.getSnapshot); }
      const row = (label, value, key) => h('div', { style: styles.row, key }, h('span', { style: styles.muted }, label), h('span', null, value));
      const phase = value => t('phase.' + value);
      const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const limit = value => value ? String(value) : t('unlimited');
      function EventView({ event, showSession, sessionId }) {
        const results = [event.paused && t('paused'), event.cancelled && t('cancelled'),
          t('compact.' + event.compaction), event.resumed && t('resumed')].filter(Boolean);
        return h('details', { style: styles.card },
          h('summary', { style: styles.summary }, time(event.at) + ' · ' + phase(event.phase)),
          showSession && row('Session', sessionId),
          row(t('turn'), event.turn),
          h('div', { style: styles.small }, t('reason')),
          h('ul', { style: { margin: '4px 0 8px', paddingInlineStart: 20 } }, event.reasons.map((reason, i) => h('li', { key: i }, reason))),
          event.stats && row(t('longestRepeat'), event.stats.maxRepeatRun + ' / ' + t('limit') + ' ' + event.limits.repeatedRunLimit),
          h('div', { style: styles.small }, t('result')),
          h('div', null, results.join(' → ')),
          event.errors.map(error => h('div', { key: error, style: styles.error }, t('error.' + error))),
        );
      }
      function NumericField({ field, value, unit, factor = 1, min = 1, step = 1, max, disabled, save }) {
        const [draft, setDraft] = React.useState(String(value * factor));
        const [invalid, setInvalid] = React.useState(false);
        const id = React.useId();
        React.useEffect(() => { setDraft(String(value * factor)); setInvalid(false); }, [value, factor]);
        function commit(input) {
          if (draft === '' || !input.checkValidity() || !Number.isFinite(Number(draft))) { setInvalid(true); return; }
          setInvalid(false);
          const next = Number(draft) / factor;
          if (next !== value) save(field, next).then(ok => { if (!ok) setDraft(String(value * factor)); });
        }
        return h('label', { htmlFor: id, style: styles.row }, h('span', null, t(field)),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', { id, type: 'number', min, max, step, value: draft, disabled, 'aria-invalid': invalid || undefined,
              style: { ...styles.input, width: 86 },
              onChange: e => setDraft(e.target.value), onBlur: e => commit(e.target),
              onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
            }), h('span', { style: styles.small }, unit)));
      }
      function Settings() {
        useLocale();
        const remote = useStatus();
        const setting = React.useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope));
        const [saving, setSaving] = React.useState(false);
        const [error, setError] = React.useState('');
        const [saved, setSaved] = React.useState(false);
        const mounted = React.useRef(true);
        React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
        const cfg = setting.value ?? remote.data?.config;
        const disabled = saving || setting.status !== 'ready' || !setting.writable || Boolean(remote.error);
        async function save(field, value) {
          setSaving(true); setError(''); setSaved(false);
          try { await scope.set(field, value); if (mounted.current) setSaved(true); store.refresh(); return true; }
          catch (err) { if (mounted.current) setError(String(err.message || err)); return false; }
          finally { if (mounted.current) setSaving(false); }
        }
        function toggle(field, additionalDisabled = false) {
          return h('label', { key: field, style: styles.row }, h('span', null, t(field)), h('input', {
            type: 'checkbox', checked: Boolean(cfg[field]), disabled: disabled || additionalDisabled,
            style: styles.check, onChange: e => save(field, e.target.checked),
          }));
        }
        const data = remote.data;
        const agents = data?.agents ?? [];
        const busy = agents.find(agent => ['queued', 'waiting', 'compacting'].includes(agent.phase));
        const status = remote.error ? t('connection') : !data ? t('loading') : phase(busy?.phase ?? (!data.config.enabled ? 'disabled' : agents.some(agent => agent.running) ? 'monitoring' : 'idle'));
        const events = agents.flatMap(agent => agent.events.map(event => ({ event, sessionId: agent.sessionId }))).sort((a, b) => b.event.at - a.event.at).slice(0, 10);
        return h('div', { style: styles.panel, 'data-reasoning-monitor': 'settings' },
          row(t('status'), h('span', { style: styles.badge, role: 'status' }, status)),
          remote.error && h('div', { role: 'alert', style: styles.error }, remote.error),
          data && h('div', { style: styles.card },
            row(t('sessions'), agents.filter(agent => agent.running).length),
            row(t('triggers'), agents.reduce((n, agent) => n + agent.fired, 0)),
            row(t('compactions'), agents.reduce((n, agent) => n + agent.compacted, 0) + ' / ' + agents.reduce((n, agent) => n + agent.compactFailed, 0)),
            h('div', { style: styles.small }, t('updated') + ' ' + time(data.now))),
          cfg && h(React.Fragment, null,
            h('h3', { style: styles.heading }, t('settings')),
            toggle('enabled'), h('div', { style: styles.small }, t('scope')),
            busy && !cfg.enabled && h('div', { style: styles.small }, t('stopped')),
            setting.status !== 'ready' && h('div', { role: 'status', style: styles.small }, t('unavailable')),
            setting.status === 'ready' && !setting.writable && h('div', { role: 'status', style: styles.small }, t('readonly')),
            h('label', { style: styles.row }, h('span', null, t('action')), h('select', { value: cfg.action, disabled: disabled || !cfg.enabled, style: styles.input, onChange: e => save('action', e.target.value) },
              ['pause-goal', 'warn', 'cancel'].map(action => h('option', { key: action, value: action }, t('action.' + action))))),
            h('div', { style: styles.small }, t('hint.' + cfg.action)),
            toggle('autoCompact', !cfg.enabled), toggle('resumeGoal', !cfg.enabled || cfg.action !== 'pause-goal'),
            h('details', null, h('summary', { style: styles.summary }, t('advanced')),
              h('div', { style: styles.panel },
                [ ['repeatedRunLimit','times'], ['perBlockLimit','sentences'], ['minChantRatio','%',100,0.1,0.1,100],
                  ['windowBlocks','blocks'], ['windowLimit','sentences'], ['turnLimit','sentences'], ['elevatedBlockLimit','sentences'],
                  ['maxStepsPerTurn','steps',1,0], ['maxTurnMinutes','minutes',1,0,0.1],
                  ['cooldownMs','seconds',0.001,0,0.1], ['compactTimeoutMs','seconds',0.001,0,0.1],
                ].map(([field, unit, factor, min, step, max]) => h(NumericField, { key: field, field, value: cfg[field], unit: unit === '%' ? '%' : t(unit), factor, min, step, max, disabled: disabled || !cfg.enabled, save })),
                h('div', { style: styles.small }, t('zero')), toggle('intervene', !cfg.enabled), toggle('verbose'))),
            h('div', { style: error ? styles.error : styles.small, role: error ? 'alert' : 'status' }, error ? t('saveFailed') + ': ' + error : saving ? t('saving') : saved ? t('saved') : ''),
          ),
          h('h3', { style: styles.heading }, t('recent')),
          !events.length && h('div', { style: styles.small }, t('empty')),
          events.map(({ event, sessionId }) => h(EventView, { key: event.id, event, sessionId, showSession: true })),
          h('div', { style: styles.small }, t('memory')),
        );
      }
      function SessionDock(props) {
        useLocale();
        const remote = useStatus();
        const data = remote.data;
        const agent = data?.agents.find(row => row.sessionId === props.sessionId);
        const cfg = data?.config;
        const current = remote.error ? t('connection') : !data ? t('loading') : phase(agent?.phase ?? (cfg.enabled ? 'waiting-data' : 'disabled'));
        return h('details', { key: props.sessionId, style: { ...styles.panel, gap: 5, padding: '4px 0' }, 'data-reasoning-monitor': 'session' },
          h('summary', { style: { ...styles.summary, fontSize: 12 } }, t('name') + ' · ' + current,
            agent?.events[0] && h('span', { style: { ...styles.small, marginInlineStart: 10 } }, t('recent') + ': ' + phase(agent.events[0].phase))),
          h('div', { style: { ...styles.card, ...styles.panel } },
            remote.error && h('div', { role: 'alert', style: styles.error }, remote.error),
            agent?.observed ? h(React.Fragment, null,
              row(t('longestRepeat'), (agent.stats?.maxRepeatRun ?? 0) + ' / ' + t('limit') + ' ' + cfg.repeatedRunLimit),
              row(t('stepCount'), (agent.budgetObserved ? agent.steps : '—') + ' / ' + t('limit') + ' ' + limit(cfg.maxStepsPerTurn)),
              row(t('elapsed'), (agent.budgetObserved ? (agent.elapsedMs / 60000).toFixed(1) : '—') + ' / ' + t('limit') + ' ' + limit(cfg.maxTurnMinutes) + ' ' + t('minutes')),
            ) : h('div', { style: styles.small }, t('observed')),
            agent?.events.map(event => h(EventView, { key: event.id, event })),
            h('div', { style: styles.small }, t('settingsPath')),
          ));
      }
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: NS, order: 161, label: () => t('name') }, Settings));
      slots.inject('conversation.input.dock', () => slots.register({ name: 'conversation.input.dock', id: NS, order: 90 }, SessionDock));
    }
    return { apply, inject: ['slots', 'settingsScope', 'locale'] };
  },
});
