# dsh-reasoning-guard

DeepSeek Harness 的**思考咏唱护栏**。检测模型 reasoning 退化成行动宣告复读，越线后告警、暂停 goal、或取消 turn。

## 它治什么

长任务、反复失败时，部分模型的 reasoning 正文会退化成这样（真实会话原文，已删去空行）：

```
**★★★ 战略重估。**

**让我用完全不同的方法。**

好。

**执行！**

**GO！**

好。

写。

好。

执行。

好。

GO。

写。

好。

（写）

好。

GO。
```

dsh 的"思考"区以 `white-space: pre-wrap` 逐段原样渲染，每个空行都保留成视觉留白，于是用户看到的是一屏接一屏的重复短句，等同死循环。

实测数据（本机 90 个历史会话）：

| 会话 | 模型 | reasoning 行数 | 咏唱行 | 占比 |
|---|---|---|---|---|
| `fb4b4f7d` | deepseek-v4.1-flash | 34529 | 52481 | — |
| `0e76f24f` | cline-pass/deepseek-v4.1-flash | 34529 | 20914 | 60.6% |
| `3eaec985` | gemini-3.8-flash-tiered | 11480 | 3404 | 29.7% |

单轮步数最高跑到 **130 步**，`0e76f24f` 的 turn 2 持续 1 小时 27 分、230036 字符 reasoning。

高频用词因模型而异：deepseek-v4.1-flash 说「好。/执行。/写。/GO。」，gemini-3.8-flash-tiered 说「做./OK./Go.」。护栏按**归一化后的核心词**判定，两侧都能覆盖。

## 它不是 goal 的问题

goal-round driver 每轮注入的 `<goal_round>` 提示词除 `Round: N/M` 外一字不差，看上去很像"反复注入同一提示词导致的循环"，但这只是表象：该会话里 goal 消息只出现 5 次，而 reasoning 块有 211 个。咏唱密度最高的那个会话根本没有 goal。goal 的作用是**续命**——在 agent idle 时重新排队下一轮，把一个已经退化的 turn 复制成多轮。

护栏因此对 goal 采取"暂停"而非"干预"：切断续命链，而不是修改注入内容。

## 安装

插件目录：`~/.dsh/plugins/dsh-reasoning-guard`

在 profile（`~/.dsh/profiles/web`）里挂载：

```jsonc
// package.json
{
  "dependencies": {
    "dsh-reasoning-guard": "link:C:/Users/<you>/.dsh/plugins/dsh-reasoning-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …
        "dsh-reasoning-guard"
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启 dsh 生效。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖默认值：

```yaml
- id: reasoning-guard
  config:
    enabled: true
    elevatedBlockLimit: 20   # 预警档：只计数，不处置
    perBlockLimit: 60        # 单个 reasoning 块的咏唱行数上限
    windowBlocks: 3          # 滑动窗口长度（块）
    windowLimit: 120         # 窗口内累计咏唱行数上限
    turnLimit: 600           # 单个 turn 累计上限
    maxStepsPerTurn: 60      # 单 turn 步数预算（0 禁用）
    maxTurnMinutes: 60       # 单 turn 时长预算（0 禁用）
    cooldownMs: 30000        # 两次触发的最小间隔
    compactTimeoutMs: 120000 # 等待压缩落定的上限（0 表示不限时）
    action: pause-goal      # warn | pause-goal | cancel（默认 pause-goal）
    autoCompact: true        # 越线后自动压缩一次上下文
    resumeGoal: true         # pause-goal 档压缩后自动恢复，自动化继续
    intervene: false         # 是否在下一步注入收敛提醒
    verbose: false
```

**阈值依据**：全部历史会话回放显示，未触发会话的最大单块咏唱行数是 **24**，阈值 60 留了 2.5 倍余量；退化会话的峰值块可达 **43601** 行。判定不需要精细的阈值调参，正常与退化之间差三个数量级。

**为什么要有预警档**：`elevatedBlockLimit` 是自我测量逼出来的。每块末尾带一两句行动宣告的"正常偏高"思考会落在 20 行上下——它和真正的退化是同一个习惯的不同量级，值得计数，不值得动会话。护栏的触发是二元的，但现象的分布不是。

**预算档：治本的那一档**

咏唱检测抓的是"已经开始退化"，预算抓的是"正在无限穷举"。这两者是不同的问题，实测足以说明：

失控会话的 130 步**不是循环**。369 个工具结果里只有 2 个是错误（0.5%），361 个不同的结果指纹（98% 的步骤都产出了新信息），293 次 pwsh 用了 96 种不同的命令首行，最长"零新信息"连续步数是 **2**。模型在一个没有验收标准的难题上不断换方法（Ghidra 反汇编、zig 编译、注册表提权、内存 dump、格式探测），每次都成功执行，每次都不解决问题。「好。执行。写。」是这种穷举的节拍器，不是复读。

`maxStepsPerTurn` 与 `maxTurnMinutes` 因此需要同时存在，因为存在两类失控：

| turn | 步数 | 实际耗时 | 单步均时 | 预算会何时按住 |
|---|---|---|---|---|
| 2 | 130 | 86.9 分 | 0.67 分 | 第 60 步 / 33.3 分 |
| 5 | 113 | 64.5 分 | 0.57 分 | 第 60 步 / 32.1 分 |
| 10 | 4 | 60.9 分 | 15.2 分 | 第 60 分钟（步数远未达标） |

前两轮是步数失控，第三轮是时长失控——只有步数预算会完全漏掉 turn 10。

**自动压缩：比暂停更接近治本**

`autoCompact`（默认开）在越线后触发一次 `ctx.compaction.compactNow`。暂停 goal 只是让循环停下来，压缩把循环赖以自我模仿的材料一起清走——这是本插件里唯一真正"治"而不是"停"的动作。

实测依据，同一个失控会话里 2 次可比较的自动压缩：

| 压缩 | 前 4 块平均咏唱 | 后 4 块平均咏唱 | 变化 |
|---|---|---|---|
| 1 | 4585.3 行 | 2.5 行 | −4582.8 |
| 2 | 20.8 行 | 0.8 行 | −20.0 |

均值 2303 → 1.6。压缩摘要里咏唱式短词残留为 **0**，而任务事实（目标原文、已完成步骤、用户后续指示）完整保留。机制是清掉复读痕迹、留下信息，同时打断上下文过长与自我模仿两件事。

样本只有 2 个，不足以断言它对所有退化都有效；但两次都是数量级的改善，且机制清楚，因此默认开启。压缩需要 `ctx.compaction` 服务，缺失或返回 `null`（无可安全压缩范围）时静默跳过，不影响其它处置。压缩本身要调一次模型生成摘要，所以是异步 fire-and-forget，不阻塞事件处理。

三个工程约束：

- **压缩排在暂停/取消之前**。pause 会被 goal-round-driver 转成 `agent.cancel({kind:"user"})`，turn 立即中止——压缩必须趁 turn 还活着跑完。
- **同一 agent 的压缩串行**。压缩经常比冷却期（30s）更久，超预算后每步都可能再次触发；在飞时的新触发等它落定而不是叠加——压缩实现在摘要期做 surface 校验，并发必然失败一方。等待受 `compactTimeoutMs` 约束，到点继续后续处置，压缩仍在后台尝试落定（若处置中止了 turn，可能因 surface 变化失败并计入失败数）。
- **恢复是默认行为**。`resumeGoal: true` 时，pause-goal 档在压缩完成后立即 `goals.resume`，驱动在 agent idle 时自动排下一轮——此时上下文已压缩。pause/resume 各推进一次 goal revision，被取消的旧 attempt 的 revision 对不上，驱动的僵尸 attempt 保护（idle 时发现 revision 不符才跳过、相符则再次暂停）不会误伤恢复。

`action` 三档：

| 值 | 行为 |
|---|---|
| `pause-goal` | 暂停 active goal 切断退化轮的续命链，压缩完成后自动恢复，自动化继续（默认） |
| `warn` | 只告警；`autoCompact` 开启时会额外触发一次压缩，不动 turn |
| `cancel` | 再额外取消当前 turn 且**不**恢复 goal——显式选择的硬手段，会留下暂停态 |

`intervene: true` 会在退化块之后的下一步注入一条收敛提醒（"停止复述意图，直接执行具体工具调用"）；预算触发（step/start 档）用的是 `budgetReminderText`，针对无限穷举而非复读。它需要 `@deepseek-ai/dsh-llm`；解析不到时静默降级为不注入，不影响插件加载。

## 使用

模型工具 `guard_status`：查看每个 agent 的块数、咏唱行数、峰值块、触发次数与最近判决。

斜杠命令 `/guard status` 与 `/guard reset`。

## 验证

```bash
# 空跑事件链路：mock ctx 驱动 apply，验证触发/处置/压缩/恢复，无需本地会话数据
node test/dryrun.mjs

# 回放全部历史会话，检查触发与误报
node test/verify.mjs

# 审计单个会话被判为咏唱的实际行
node test/audit.mjs <会话路径片段>
```

`verify.mjs` 会打印未触发会话的最大峰值块与阈值余量——阈值调紧之前先看这个数。

## 局限

只在**会话事件流**上统计，即 reasoning 已经完整落盘之后。块内复读要靠 `perBlockLimit` 抓住，块间的累积要靠窗口与 turn 上限，但一个正在生成的巨型块在它结束前不会被判定。

`cancel` 档用 `{ kind: 'parent' }` 取消，语义是"由 harness 层中止"，与 goal-round-driver 的 teardown 一致。

护栏不改变模型的退化倾向，只保证它不再无声烧掉上下文。根因（模型在长任务上的思考退化）仍需靠换模型或降低 `reasoningEffort` 来治理。

## License

MIT
