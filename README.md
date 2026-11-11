# dsh-wait-guard

给「等待」和「轮询」加预算的 DSH 插件：限制后台任务的 `job_output wait`，拦截嵌套在 `run_code` 里的超长前台命令，在 `run_code` 撞上自己的程序截止时间或 JS 解析错误时说清楚原因，并熔断「连续只查状态」的循环。

## 安装

```bash
dsh plugin --profile <profile> add dsh-wait-guard
# 或直接从 GitHub 安装
dsh plugin --profile <profile> add github:Lion-Li-git/dsh-wait-guard
```

装完新开一个会话即可生效（bundle 补丁会挂一行 `wait-guard`）。

## 它解决什么

五件事，全部走宿主平面的 `tools/pre-execute` / `tools/post-execute`，不改任何工具实现。

1. **`job_output` 的 `wait: true` 变成有预算的探测**：单次 ≤ 20 秒；只允许在任务开始后 2 分钟内；同一个任务累计 ≤ 40 秒。超出的调用立即被拒（1ms 级），并把「结束回合、等完成通知」写进拒绝理由。
2. **嵌套在 `run_code` 里的前台 `pwsh`**：如果它的 `timeoutMs` 超过 `run_code` 的程序截止时间（默认 120000ms），直接拒绝——那条命令会在截止点被连带中止，等也白等。
3. **`run_code` 的耗时反馈**：程序在前台占用超过 45 秒，或撞到 `execution deadline reached`，结果后追加一段说明：那是程序自己的预算（可调），不是任务上限；长活应该 `run_in_background` 然后结束回合。
4. **状态轮询熔断**：同一 agent 在 120 秒内连续 4 次「只查状态」就 `deny`——`run_code` / 直接 `pwsh` 的命令体只读 job 状态、日志尾巴、进程列表、时钟，且不含写操作；直接的无 wait `job_output` 也算。拒绝理由要求「用已知状态直接回答、说明 job 仍在跑、结束 turn」，第 2 次拒绝升级为「后续每次探针都会被拒」。任何写操作/工作型命令（`git add`、`npm run`、`node tools/`、`write`/`edit`、`Start-Process` 等）把计数清零；超过 120 秒自动清零。
5. **JS 解析错误提示**：`run_code` 报 `Expected ',', got 'ident'` / `Unexpected token` / `Invalid or unexpected token` 时，追加「模板字符串反引号」提示，并报出程序里的反引号个数。PowerShell 的 `` `t `` / `` `n ``、Markdown 里的反引号都会提前结束 JS 模板。

## 为什么要这个

在长会话里实测（session b3a09167，4 天）：

| 观测 | 数据 |
|---|---|
| `job_output` 带 `wait: true` | 59 次，累计阻塞 **5447 秒（约 91 分钟）** |
| 其中 `timeout_ms: 115000` | 52 次——把 120 秒上限当成了预算，贴着上限循环 |
| 单个任务最多连等 | 6 次（任务本身 17 分钟） |
| 单次命令跑满 120 秒被程序截止杀掉 | 现网会话里可复现，且报错读起来像「任务不许超过两分钟」 |

状态轮询是同一类毛病的下一层（session 04e0a3ef，Epirus-Web）：

| 观测 | 数据 |
|---|---|
| turn 18：用户问「怎么跑了 50 分钟」 | 第 2 步已得出完整答案；之后 47 步只查日志/进程，0 条文本，reasoning 一路写 `Answer now.`，2.3 分钟后用户按停止 |
| turn 22：用户问「你现在在干啥」 | 之后 13 步只有工具调用，`job_output` 反复返回 `running`，最后被 abort |
| 同一 turn 的 `run_code` 解析错误 | 7 次，全部是模板字符串里混进反引号；错误没有行号，模型只能整段重写 |

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
    probeLimit: 4            # 连续第几次状态探针开始拒绝
    probeWindowMs: 120000    # 探针计数窗口；超过就清零
```

## 行为与副作用

- **失败即放行**：查不到 jobs 服务、工具名不匹配、参数畸形，一律 `next()`，绝不误伤。
- **拒绝会让当前 `run_code` 程序中止**（未 catch 的 `ToolCallError`）——这是刻意的停止信号，已经完成的副作用不回滚。
- **状态探针是启发式**：用 `node -e` 读日志之类的方式不会被识别；它拦的是最常见的 `job_output` / 日志 tail / 进程检查。
- 只影响模型发起的调用；人手动跑的终端/命令不受影响。

## 测试

```bash
npm test
```

`node --test` 覆盖：4 次探针拒绝与升级、工作命令重置、`wait: true` 不受探针计数影响、直接 `job_output` / `pwsh`、嵌套 `pwsh` 超时、解析错误提示只加一次、deadline 提示仍生效。

## 版本

- **0.2.0**（2026-11-11）：新增状态轮询熔断（`probeLimit` / `probeWindowMs`）与 `run_code` 解析错误提示。
- **0.1.0**：`job_output wait` 预算、嵌套 `pwsh` 超时拦截、`run_code` 慢/截止提示。

## 兼容性

DSH `>=0.2.0`，cordis `>=4`，Node `>=22.19`。无运行时依赖，纯 ESM。

## License

MIT
