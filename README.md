# dsh-memguard — DSH 内存守卫

> **拥有**：agent 启动进程的 RSS 采样与越界 kill（账本由 `tools/execute` 窗口差集建立）、`memguard_status` 工具与 `/dsh-memguard` 路由。
> **冲突时**：与 `dsh-memory` 只差两个字母但领域无关（那个管提示词记忆）；本插件是 host 半边，不碰 UI。
> **回滚**：删 `dsh-memguard` insert + 重启应用。

AI 启动的脚本内存无限增长（泄漏/溢出风险）时：**直接杀掉进程树 + 自动给 agent 插一条警告提示词**，让模型修泄漏而不是原样重跑。

## 工作方式（host 半边，零 npm 依赖）

1. **归因**：`tools/execute` 钩子环绕每次工具执行，对 host（Electron main）进程的后代树做差集快照，新出现的 pid 记入账本（`pid → {agentId, pgid, comm, args}`）。前台命令与后台 job 都覆盖。
2. **采样**：每 3s 一次 `ps -axo pid,ppid,pgid,rss,comm` 全表扫描（500ms 缓存去重），按 `(agentId, pgid)` 组聚合账本进程及其后代。
3. **判定**（组内，任一命中）：
   - 总 RSS ≥ `absThresholdMb`（默认 1536）且连续 `absConsecutive`（默认 2）次采样仍超；
   - 最近 `growthSamples`（默认 5）次采样单调不降、累计涨幅 ≥ `growthDeltaMb`（默认 400）、当前 ≥ `growthFloorMb`（默认 600）。
4. **处置**：SIGTERM 目标组（含 host 后代树内子进程）→ 3s 后仍存活者 SIGKILL。只杀账本内进程及其后代，Electron Helper 与 host 同组进程永不进入账本。
5. **通知**：
   - agent running → `agent.steer(msg)`（下一步立即看到）；idle → `agent.followup(msg)`（拉起新 turn）。消息带 `[dsh-memguard]` 前缀、进程组信息、RSS 曲线与修复指引。
   - `tools/post-execute` 对该 agent 30s 内被杀事件附加 `additionalContexts`，解释命令为何非零退出。
6. **可见性**：system-prompt 注入守卫说明（`notifySystemPrompt` 可关）；`memguard_status` 工具查状态/事件；`GET /dsh-memguard` JSON 状态路由；事件落盘 `~/.dsh/dsh-memguard/events.jsonl`（2MB 轮转）。

## 配置

`~/.dsh/dsh-memguard/settings.json`（live re-read，约 10s 生效；`POST /dsh-memguard/settings` 也可改）：

```json
{
  "enabled": true,
  "sampleIntervalMs": 3000,
  "absThresholdMb": 1536,
  "absConsecutive": 2,
  "growthSamples": 5,
  "growthDeltaMb": 400,
  "growthFloorMb": 600,
  "cooldownMs": 60000,
  "notifySystemPrompt": true,
  "warnRecentWindowMs": 30000,
  "excludeCommPatterns": ["Helper"]
}
```

## 挂载（desktop profile）

1. `~/.dsh/profiles/desktop/package.json` 的 dependencies 加：
   `"dsh-memguard": "link:../../local-plugins/dsh-memguard"`
2. `~/.dsh/profiles/desktop/cordis.patch.yml` 加：

   ```yaml
   - insert:
       - id: dsh-memguard
         name: dsh-memguard
   ```

3. profile 里 `pnpm install`，然后**完全退出并重开 DSH Desktop**（host 半边新插件必须重启）。

## 卸载/回滚

删掉上面两处挂载 + 重启即可。`~/.dsh/dsh-memguard/` 下的事件/设置可随手删。
