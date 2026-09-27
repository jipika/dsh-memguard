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

## 设置面板（client 半边）

「设置 → 插件 → 内存守卫」里是本插件的配置页（挂 `settings.plugins.tab`；该 slot 的 `id` 必须等于**插件包名**，宿主是按插件清单行的 id 用 `{ only: row.id }` 过滤渲染 tab 的，写成别的字符串会落在一个永不渲染的行上）：

- 总开关 `enabled` 与提示词注入开关 `notifySystemPrompt`；
- 一键预设：**大项目友好**（4G 阈值 / 60 秒增长窗口——Nuxt·Vite 这类冷启动就要吃 1~2G 的构建不再被误杀）与**恢复插件默认值**（默认值由 `GET /dsh-memguard` 的 `defaults` 下发，不在前端硬编码）；
- 全部阈值字段（含 `growthSamples` 的 12 点硬上限说明）与 `excludeCommPatterns` 名单；
- 实时状态：跟踪进程数、活跃进程组的 RSS、最近三次触发/终止事件。

面板只走 host 已有的两条路由：`GET /dsh-memguard` 与 `POST /dsh-memguard/settings`，保存即时生效（host 侧 live re-read + `invalidateSettings()`），不必重启守卫。

⚠️ 这个 POST 曾经是条哑路由：prefix 注册下 `req.url` 是**完整路径** `/dsh-memguard/settings`，而旧代码比对的是 `/settings` → 请求静默落进 GET 分支，写盘为 0（2026-09-27 实测）。现在两种形态都收；面板侧还会比对服务端回填值，不一致就直接报错，而不是假装保存成功。

## 配置

`~/.dsh/dsh-memguard/settings.json`（live re-read，约 10s 生效）——**优先用设置面板改**，手写 JSON 或 `POST /dsh-memguard/settings` 也行：

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
4. **动过 `package.json` 的 `dsh.client`（新增/移除 client 半边）同样要完全重启**：client 模块清单是宿主启动时读的。之后只改 `lib/client.js` 的**内容**则刷新页面即可——宿主每次生成 boot HTML 会重算每个模块的哈希（`plugins/??dsh-memguard/client.js&rev=…` 的 rev 会变）。

## 卸载/回滚

删掉上面两处挂载 + 重启即可。`~/.dsh/dsh-memguard/` 下的事件/设置可随手删。
