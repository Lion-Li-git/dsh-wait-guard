# dsh-wait-guard

给「等待」加预算的 DSH 插件：限制后台任务的 `job_output wait`，拦截嵌套在 `run_code` 里的超长前台命令，并在 `run_code` 撞上自己的程序截止时间时说清楚那是什么。

## 安装

```bash
dsh plugin --profile <profile> add dsh-wait-guard
# 或直接从 GitHub 安装
dsh plugin --profile <profile> add github:Lion-Li-git/dsh-wait-guard
```

装完新开一个会话即可生效（bundle 补丁会挂一行 `wait-guard`）。

## 它解决什么

三件事，全部走宿主平面的 `tools/pre-execute` / `tools/post-execute`，不改任何工具实现。

1. **`job_output` 的 `wait: true` 变成有预算的探测**：单次 ≤ 20 秒；只允许在任务开始后 2 分钟内；同一个任务累计 ≤ 40 秒。超出的调用立即被拒（1ms 级），并把「结束回合、等完成通知」写进拒绝理由。
2. **嵌套在 `run_code` 里的前台 `pwsh`**：如果它的 `timeoutMs` 超过 `run_code` 的程序截止时间（默认 120000ms），直接拒绝——那条命令会在截止点被连带中止，等也白等。
3. **`run_code` 的耗时反馈**：程序在前台占用超过 45 秒，或撞到 `execution deadline reached`，结果后追加一段说明：那是程序自己的预算（可调），不是任务上限；长活应该 `run_in_background` 然后结束回合。

## 为什么要这个

在长会话里实测（session b3a09167，4 天）：

| 观测 | 数据 |
|---|---|
| `job_output` 带 `wait: true` | 59 次，累计阻塞 **5447 秒（约 91 分钟）** |
| 其中 `timeout_ms: 115000` | 52 次——把 120 秒上限当成了预算，贴着上限循环 |
| 单个任务最多连等 | 6 次（任务本身 17 分钟） |
| 单次命令跑满 120 秒被程序截止杀掉 | 现网会话里可复现，且报错读起来像「任务不许超过两分钟」 |

默认参数就是按这组数据定的。

## 配置

在 profile 的 `cordis.patch.yml` 里给这一行加 `config`（单位毫秒，全部可选）：

```yaml
- id: wait-guard
  config:
    perCallMaxMs: 20000      # 单次 wait 上限
    youngMs: 120000          # 只允许等「年龄小于它」的任务
    totalBudgetMs: 40000     # 同一任务累计等待上限
    defaultWaitMs: 30000     # 调用方没传 timeout_ms 时按它算
    slowProgramMs: 45000     # run_code 超过它就追加慢提示
    programDeadlineMs: 120000 # run_code 的默认程序截止时间
```

## 行为与副作用

- **失败即放行**：查不到 jobs 服务、工具名不匹配、参数畸形，一律 `next()`，绝不误伤。
- **拒绝会让当前 `run_code` 程序中止**（未 catch 的 `ToolCallError`）——这是刻意的停止信号，已经完成的副作用不回滚。
- 只影响模型发起的调用；人手动跑的终端/命令不受影响。

## 兼容性

DSH `>=0.2.0`，cordis `>=4`，Node `>=22.19`。无运行时依赖，纯 ESM。

## License

MIT
