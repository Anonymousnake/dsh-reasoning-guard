# dsh-reasoning-guard

DeepSeek Harness 插件：监测 reasoning 中重复的短句，以及单轮步数或时长超预算的情况。触发时记录告警；可选择压缩上下文、暂停并恢复 goal，或取消当前轮次。

## 安装

适配 dsh `0.1.5-rc.1`。在 profile 的 `package.json` 中加入本地依赖和 bundle：

```json
{
  "dependencies": {
    "dsh-reasoning-guard": "link:C:/path/to/dsh-reasoning-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-reasoning-guard"]
    }
  }
}
```

保留 profile 已有的其他 bundle；上述数组只展示本插件的位置。运行 `pnpm install`，然后重启 dsh。插件 bundle 的 `cordis.patch.yml` 会注册 host 层护栏，无须修改内置 preset。

## 工作方式

- `assistant/message` 落盘后分析 reasoning：统计单块、滑动窗口和当前 turn 中的重复短句。`step/start` 检查单轮步数与时长。正在流式生成的 reasoning 要等消息落盘后才计入。
- `autoCompact: true` 时，通过 `agentPresets.serviceFor(agent, 'compaction')` 寻址当前 agent 所属 preset 的隔离压缩服务；非 preset 部署可使用 host 服务。手动压缩只接受 idle agent 和有效的 `AbortSignal`。
- `pause-goal` 在触发时暂停 active goal，使运行中的退化轮结束；agent 到达 idle 后发起一次压缩，结算后按新的 goal revision 恢复自动续轮。`warn` 保持轮次运行，等它自然结束后尝试压缩。`cancel` 会取消当前轮次，已暂停的 goal 保持暂停。
- 同一 agent 的重复触发在待压缩或压缩运行期间合并。超时会请求取消压缩，并让 goal 恢复；压缩失败或没有可压缩范围也计入失败次数。压缩结果取决于上下文是否存在可收缩范围，不能保证每次都会缩减。

## 配置

插件自带配置见 `cordis.patch.yml`，可在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: reasoning-guard
  config:
    enabled: true
    elevatedBlockLimit: 20    # 只计数的预警档
    perBlockLimit: 60         # 单块重复短句阈值
    windowBlocks: 3           # 滑动窗口长度（块）
    windowLimit: 120          # 窗口内累计阈值
    turnLimit: 600            # 当前 turn 累计阈值
    maxStepsPerTurn: 60       # 0 表示禁用
    maxTurnMinutes: 60        # 0 表示禁用
    cooldownMs: 30000         # 两次判决的最小间隔
    compactTimeoutMs: 120000  # 0 表示不限时
    action: pause-goal        # warn | pause-goal | cancel
    autoCompact: true
    resumeGoal: true          # 仅对 pause-goal 有效
    intervene: false         # 下一步附加收敛提醒
    verbose: false
```

| `action` | 触发后的行为 |
| --- | --- |
| `pause-goal` | 暂停 active goal，idle 后压缩，随后恢复；默认值。 |
| `warn` | 仅告警；启用自动压缩时，等待当前轮次自然结束。 |
| `cancel` | 暂停 active goal 并取消当前轮次；保留暂停状态。 |

没有 active goal 时，`pause-goal` 不会主动取消当前轮次；若启用压缩，它等待自然到达 idle。`resumeGoal: false` 会让 `pause-goal` 的暂停状态保持不变。`intervene` 使用可选的 `@deepseek-ai/dsh-llm` 消息工厂，缺失时使用本地消息结构。

## 查看与验证

`/guard status` 或模型工具 `guard_status` 展示实时阈值、触发数、压缩成功/失败数和最近判决；`/guard reset` 清空统计。尚未观察到 agent 时，压缩可用性显示“等待 agent”。

```sh
node test/dryrun.mjs            # 模拟事件、隔离服务、idle 压缩和 goal 恢复
node test/verify.mjs            # 回放本机历史会话（需要会话数据）
node test/audit.mjs <会话片段>  # 检查一个会话中匹配的短句
```

`verify.mjs` 依赖当前 Node 的 Zstandard 解压能力；它只读 `~/.dsh/sessions`。判定只覆盖插件定义的短句模式，不代表对 reasoning 内容质量的通用评估。

## 许可

MIT
