// dsh-memguard — 内存守卫（host 半边，零 npm 依赖）
//
// 目标：AI 启动的脚本/进程如果内存无限增长（泄漏/溢出风险），守卫直接杀掉
// 整个进程树，并向发起任务的 agent 自动插话（steer/followup），告知内存
// 异常与处置结果，让模型去修复而不是重跑。
//
// 工作原理（全部基于本机挖源实测的平台 API）：
//   · 归因：`tools/execute` 瀑布钩子环绕每次工具执行，执行前后对 host 进程
//     的后代树做差集快照，新出现的 pid 记入账本（pid → {agentId, pgid, ...}）。
//     前台命令与后台 job 的进程都能覆盖（job 的 next() 立即返回，进程活着，
//     采样器继续按账本归属跟踪）。
//   · 采样：每 sampleIntervalMs 用一次 `ps -axo pid,ppid,pgid,rss,comm`
//     全表扫描（带 500ms 缓存去重），按 (agentId, pgid) 组聚合 RSS。
//   · 判定（组内）：
//       a) 总 RSS ≥ absThresholdMb 且连续 absConsecutive 次采样仍超 → 杀
//       b) 最近 growthSamples 次采样单调不降、累计增量 ≥ growthDeltaMb、
//          且当前 ≥ growthFloorMb → 杀
//   · 处置：先 SIGTERM 目标 pid 集合（含其 host 后代树内的子进程），
//     3s 后仍存活的 SIGKILL。只杀账本内的进程及其后代，绝不碰无关进程。
//   · 通知：杀完立即 `ctx.agents.get(agentId)` → running 则 `agent.steer(msg)`
//     （下一步就看到），idle 则 `agent.followup(msg)`（拉起新 turn）。
//     消息形状照抄官方 tool-jobs 的插话范式（source {kind, form, summary}）。
//     同时 post-execute 钩子对该 agent 近期被杀事件附加 additionalContexts，
//     解释「为什么命令返回非零」。
//   · 可见性：system-prompt 注入一段守卫说明；注册 memguard_status 工具；
//     webServer 路由 /dsh-memguard 输出 JSON 状态；事件落盘 events.jsonl。
//
// 配置：~/.dsh/dsh-memguard/settings.json（live re-read，10s 缓存）。
// 事件：~/.dsh/dsh-memguard/events.jsonl（2MB 轮转）。
//
// 挂载：desktop profile package.json dependencies 加
//   "dsh-memguard": "link:../../local-plugins/dsh-memguard"
// + cordis.patch.yml insert {id: dsh-memguard, name: dsh-memguard}
// + pnpm install + 重启 DSH Desktop（host 半边新插件必须重启）。

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const name = "dsh-memguard";

// 调试开关：MEMGUARD_DEBUG=1 时向 stderr 打关键链路
const DEBUG = process.env.MEMGUARD_DEBUG === "1" || process.env.MEMGUARD_DEBUG === "true";
function debug(...args) {
  if (DEBUG) console.error("[dsh-memguard:debug]", ...args);
}

// agents 一定要（查 live agent 并插话）；webServer 可选（状态路由）。
export const inject = ["agents", "webServer", "systemPrompt", "tools"];

const STATE_DIR = join(homedir(), ".dsh", "dsh-memguard");
const SETTINGS_FILE = join(STATE_DIR, "settings.json");
const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;

const DEFAULTS = {
  enabled: true,
  sampleIntervalMs: 3000,
  absThresholdMb: 1536,   // 组内总 RSS 绝对阈值
  absConsecutive: 2,      // 连续多少次采样都超绝对阈值才杀（防瞬时尖峰）
  growthSamples: 5,       // 增长判定的采样窗口
  growthDeltaMb: 400,     // 窗口内累计增量阈值
  growthFloorMb: 600,     // 增长判定的最低当前 RSS（避免小进程误报）
  cooldownMs: 60_000,     // 同一进程组两次处置的最小间隔
  notifySystemPrompt: true,
  warnRecentWindowMs: 30_000, // post-execute 附加警告的时间窗
  excludeCommPatterns: ["Helper"], // comm 命中（子串，大小写敏感）的进程永不记账/处置
};

// ────────────────────────────── 设置（live re-read） ──────────────────────────────

let settingsCache = { at: 0, value: { ...DEFAULTS } };

function readSettings() {
  const now = Date.now();
  if (now - settingsCache.at < 10_000) return settingsCache.value;
  let value = { ...DEFAULTS };
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (parsed && typeof parsed === "object") value = { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* 坏文件回落默认 */
  }
  settingsCache = { at: now, value };
  return value;
}

/** 立即失效设置缓存（webServer PATCH 用）。 */
function invalidateSettings() {
  settingsCache = { at: 0, value: { ...DEFAULTS } };
}

/**
 * POST /settings 的入参钳制：只认已知键，数值夹进各自区间并取整，坏值直接丢弃。
 * 设置面板是唯一的写入口，但路由本身无鉴权（本地 GUI），所以这一层不能省：
 * 少了它，一个手滑的 "absThresholdMb": "abc" 就能让守卫永久失效或乱杀。
 */
function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  const takeNum = (key, min, max) => {
    if (!(key in input)) return;
    const n = Number(input[key]);
    if (!Number.isFinite(n)) return;
    out[key] = Math.min(max, Math.max(min, Math.round(n)));
  };
  const takeBool = (key) => {
    if (!(key in input)) return;
    out[key] = input[key] === true;
  };
  takeBool("enabled");
  takeNum("sampleIntervalMs", 1000, 600_000);
  takeNum("absThresholdMb", 0, 262_144); // 0 = 关闭绝对阈值判定
  takeNum("absConsecutive", 1, 12);
  takeNum("growthSamples", 2, 12); // 12 = series 的硬上限，再大也不会生效
  takeNum("growthDeltaMb", 0, 262_144); // 0 = 关闭增长判定
  takeNum("growthFloorMb", 0, 262_144);
  takeNum("cooldownMs", 0, 3_600_000);
  takeNum("warnRecentWindowMs", 0, 600_000);
  takeBool("notifySystemPrompt");
  if (Array.isArray(input.excludeCommPatterns)) {
    out.excludeCommPatterns = input.excludeCommPatterns
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, 32);
  }
  return out;
}

// ────────────────────────────── 事件日志 ──────────────────────────────

function appendEvent(event) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    let line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    try {
      if (statSync(EVENTS_FILE).size > MAX_EVENTS_BYTES) {
        renameSync(EVENTS_FILE, `${EVENTS_FILE}.old`);
      }
    } catch {
      /* 首次写入前文件不存在属正常 */
    }
    appendFileSync(EVENTS_FILE, line);
  } catch {
    /* 日志失败绝不影响守卫本身 */
  }
}

// ────────────────────────────── 进程快照 ──────────────────────────────

let snapshotCache = { at: 0, byPid: null };

/** 本守卫 ps 探针的进程识别：comm 是 ps 且 ppid 是 host（每次采样 pid 都不同，绝不能记账）。 */
function isProbeProc(p) {
  return (p.comm === "ps" || p.comm.endsWith("/ps")) && p.ppid === process.pid;
}

/**
 * 全表进程快照：Map<pid, {pid, ppid, pgid, rssKb, comm}>。
 * 默认 500ms 缓存去重；force=true 绕过缓存（tools/execute 窗口边界用）。
 */
function snapshot(force) {
  const now = Date.now();
  if (!force && snapshotCache.byPid && now - snapshotCache.at < 500) return snapshotCache.byPid;
  const byPid = new Map();
  try {
    const r = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss=,comm="], {
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status === 0 || r.stdout?.length) {
      for (const raw of String(r.stdout).split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const p = {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          pgid: Number(m[3]),
          rssKb: Number(m[4]),
          comm: m[5].trim(),
        };
        if (isProbeProc(p)) continue; // 守卫自己的探针绝不入表
        byPid.set(p.pid, p);
      }
    }
  } catch {
    /* ps 失败返回上一份或空表 */
  }
  snapshotCache = { at: now, byPid };
  return byPid;
}

/**
 * host 进程的后代集合（host = Electron main = 本插件运行进程）。
 * 返回 Map<pid, proc>。排除 comm 命中 excludeCommPatterns 的进程
 * （Electron Helper 这类宿主自身组件）。注意：agent 的前台命令继承
 * host 的 pgid（spawn 不 detached），所以绝不能按 pgid 过滤。
 */
function descendants() {
  const cfg = readSettings();
  const excludes = Array.isArray(cfg.excludeCommPatterns) ? cfg.excludeCommPatterns : [];
  const all = snapshot();
  const hostPid = process.pid;
  // ppid 邻接表
  const children = new Map();
  for (const p of all.values()) {
    if (p.pid === hostPid) continue;
    if (excludes.some((pat) => typeof pat === "string" && pat.length > 0 && p.comm.includes(pat))) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const seen = new Map();
  const stack = [...(children.get(hostPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    const p = all.get(pid);
    if (!p) continue;
    seen.set(pid, p);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return seen;
}

// ────────────────────────────── 账本 ──────────────────────────────

/** pid → { agentId, pgid, comm, args, firstSeen }；只记工具执行窗口内新出现的 host 后代。 */
const ledger = new Map();

/** agentId → 最近一次被守卫处置的时间戳（post-execute 附加警告用）。 */
const recentKills = new Map();

// ────────────────────────────── tools/execute 钩子（窗口差集记账） ──────────────────────────────

async function executeHook(exec, next) {
  const agentId = exec?.agent?.id;
  // 窗口边界都要强制刷新：before 太旧会扩大误杀范围，after 必须覆盖工具 spawn 的进程
  const beforePids = snapshot(true);
  const result = await next();
  try {
    const cfg = readSettings();
    if (!cfg.enabled || !agentId) return result;
    const after = snapshot(true);
    let argsLookups = 0;
    for (const [pid, p] of after) {
      if (beforePids.has(pid)) continue;
      if (ledger.has(pid)) continue;
      let args = "";
      try {
        if (argsLookups < 20) { // 逐个查全命令行有成本，超出部分用 comm 兜底
          argsLookups++;
          const cmd = spawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { timeout: 2000 });
          args = String(cmd.stdout ?? "").trim().split("\n")[0].slice(0, 300);
        }
      } catch {
        /* 拿不到就空着 */
      }
      ledger.set(pid, { agentId, pgid: p.pgid, comm: p.comm, args: args || p.comm, firstSeen: Date.now() });
      debug(`ledger + pid ${pid} (${p.comm}) agent=${agentId} pgid=${p.pgid}`);
    }
  } catch {
    /* 记账失败绝不影响工具结果 */
  }
  return result;
}

// ────────────────────────────── 组聚合与泄漏判定 ──────────────────────────────

/** (agentId|pgid) → [ {t, rssMb, pids} ... ] 最近 12 个采样。 */
const series = new Map();

function groupKeyOf(entry) {
  return `${entry.agentId}|${entry.pgid}`;
}

/**
 * 把账本映射到当前活着的进程：返回 Map<groupKey, {agentId, pgid, pids:Set, totalRssMb, topComm}>。
 * 账本里已死的 pid 顺带清掉；账本 pid 的 host 后代（子进程）并入该组。
 */
function activeGroups() {
  const cfg = readSettings();
  const live = descendants();
  // 清账
  for (const pid of ledger.keys()) if (!live.has(pid)) ledger.delete(pid);
  // 账本 pid 的后代并入组（同一 leak 树）
  const byGroup = new Map();
  const rootPids = new Set(ledger.keys());
  const assign = (pid, entry) => {
    const key = groupKeyOf(entry);
    let g = byGroup.get(key);
    if (!g) {
      g = { agentId: entry.agentId, pgid: entry.pgid, pids: new Set(), totalRssKb: 0, topComm: entry.comm, topArgs: entry.args };
      byGroup.set(key, g);
    }
    g.pids.add(pid);
    g.totalRssKb += live.get(pid)?.rssKb ?? 0;
  };
  for (const [pid, entry] of ledger) {
    if (live.has(pid)) assign(pid, entry);
  }
  // 后代扩散（host 后代树内，以账本 pid 为根）
  const all = snapshot();
  const children = new Map();
  for (const p of all.values()) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  for (const root of rootPids) {
    const entry = ledger.get(root);
    if (!entry || !live.has(root)) continue;
    const stack = [...(children.get(root) ?? [])];
    while (stack.length > 0) {
      const pid = stack.pop();
      if (!live.has(pid) || rootPids.has(pid)) continue;
      assign(pid, entry);
      for (const c of children.get(pid) ?? []) stack.push(c);
    }
  }
  const out = new Map();
  const mb = (kb) => Math.round(kb / 1024);
  for (const [key, g] of byGroup) {
    out.set(key, { ...g, totalRssMb: mb(g.totalRssKb) });
  }
  debug(`activeGroups: ledger=${ledger.size} live=${live.size} groups=${out.size}`);
  for (const [key, g] of out) debug(`  group ${key}: ${g.pids.size} pids ${g.totalRssMb}MB`);
  return out;
}

/**
 * 泄漏判定：返回 {trigger, detail} 或 null。
 * series 维护在调用方（采样器）。
 */
function evaluate(groupKey, group, hist, cfg) {
  const now = Date.now();
  hist.push({ t: now, rssMb: group.totalRssMb });
  while (hist.length > 12) hist.shift();
  // a) 绝对阈值
  if (cfg.absThresholdMb > 0) {
    let consecutive = 0;
    for (let i = hist.length - 1; i >= 0 && hist[i].rssMb >= cfg.absThresholdMb; i--) consecutive++;
    if (consecutive >= Math.max(1, cfg.absConsecutive)) {
      return {
        trigger: "abs",
        detail: `当前总内存 ${group.totalRssMb}MB，已连续 ${consecutive} 次采样超过绝对阈值 ${cfg.absThresholdMb}MB`,
      };
    }
  }
  // b) 持续增长
  const n = cfg.growthSamples;
  if (hist.length >= n && cfg.growthDeltaMb > 0) {
    const window = hist.slice(-n);
    let monotonic = true;
    for (let i = 1; i < window.length; i++) {
      if (window[i].rssMb < window[i - 1].rssMb) { monotonic = false; break; }
    }
    const delta = window[window.length - 1].rssMb - window[0].rssMb;
    if (monotonic && delta >= cfg.growthDeltaMb && window[window.length - 1].rssMb >= cfg.growthFloorMb) {
      return {
        trigger: "growth",
        detail: `${n} 次采样内持续增长 ${window[0].rssMb}MB → ${window[window.length - 1].rssMb}MB（涨幅 ${delta}MB ≥ ${cfg.growthDeltaMb}MB）`,
      };
    }
  }
  return null;
}

// ────────────────────────────── 杀进程树 + 通知 ──────────────────────────────

const killing = new Set(); // groupKey 防重入

function collectTargetPids(group) {
  // 目标 = 组内账本 pid + 它们在 host 后代树内的后代
  const live = descendants();
  const all = snapshot();
  const children = new Map();
  for (const p of all.values()) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const targets = new Set(group.pids);
  const stack = [...group.pids];
  while (stack.length > 0) {
    const pid = stack.pop();
    for (const c of children.get(pid) ?? []) {
      if (targets.has(c) || !live.has(c)) continue;
      targets.add(c);
      stack.push(c);
    }
  }
  return [...targets];
}

function signalPids(pids, sig) {
  let delivered = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
      delivered++;
    } catch {
      /* 进程已死/无权限：忽略 */
    }
  }
  return delivered;
}

/** TERM → 3s → KILL；结束后写事件 + 插话。 */
function executeKill(ctx, group, groupKey, reason) {
  if (killing.has(groupKey)) return;
  killing.add(groupKey);
  const targets = collectTargetPids(group);
  const termCount = signalPids(targets, "SIGTERM");
  const finish = (extra) => {
    killing.delete(groupKey);
    series.delete(groupKey);
    const event = {
      event: "kill",
      agentId: group.agentId,
      pgid: group.pgid,
      trigger: reason.trigger,
      detail: reason.detail,
      rssMb: group.totalRssMb,
      pids: targets,
      commands: [...new Set([...ledger.values()].filter((e) => e.pgid === group.pgid).map((e) => e.args).filter(Boolean))].slice(0, 5),
      ...extra,
    };
    appendEvent(event);
    recentKills.set(group.agentId, { at: Date.now(), event });
    notifyAgent(ctx, event);
  };
  setTimeout(() => {
    try {
      const stillAlive = targets.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      const killCount = stillAlive.length > 0 ? signalPids(stillAlive, "SIGKILL") : 0;
      finish({ sigterm: termCount, sigkill: killCount });
    } catch (error) {
      finish({ error: String(error?.message ?? error) });
    }
  }, 3000);
}

/** 照官方 tool-jobs 的插话范式：running → steer，idle → followup，人不在 → 忽略。 */
function notifyAgent(ctx, event) {
  try {
    const agent = ctx.get("agents")?.get(event.agentId);
    if (!agent) return;
    const cmds = (event.commands ?? []).filter(Boolean);
    const lines = [
      `⚠️ [dsh-memguard] 内存守卫已终止你启动的进程（${event.trigger === "abs" ? "超过内存绝对阈值" : "内存持续异常增长"}）`,
      `- 进程组 pgid ${event.pgid}，当前总内存 ${event.rssMb}MB`,
      `- 判定：${event.detail}`,
      cmds.length > 0 ? `- 命令：${cmds.slice(0, 3).join(" ; ").slice(0, 300)}` : null,
      `- 处置：SIGTERM×${event.sigterm ?? "?"} → 存活者 SIGKILL×${event.sigkill ?? 0}`,
      "",
      "请把这视为该命令已失败：分析内存增长根因（无限缓存、未释放句柄、死循环追加、指数增长的数据结构、加载了超大文件到内存等），修复后再用小数据量验证；不要原样重跑同一条命令。注意电脑内存，避免再启动不受控的高内存任务。",
    ].filter((l) => l !== null);
    const message = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: lines.join("\n") }],
      source: {
        kind: "dsh-memguard",
        form: "notice",
        summary: `已终止泄漏进程组 pgid ${event.pgid}（${event.rssMb}MB）`,
      },
    };
    if (agent.status === "idle") agent.followup(message);
    else agent.steer(message);
    appendEvent({ event: "notify", agentId: event.agentId, delivery: agent.status === "idle" ? "followup" : "steer", pgid: event.pgid });
  } catch (error) {
    appendEvent({ event: "notify-error", agentId: event.agentId, error: String(error?.message ?? error) });
  }
}

// ────────────────────────────── 采样器 ──────────────────────────────

let samplerTimer = null;

function startSampler(ctx) {
  if (samplerTimer) return;
  const tick = () => {
    try {
      const cfg = readSettings();
      if (!cfg.enabled) { debug("tick: disabled"); return; }
      debug("tick: start");
      const groups = activeGroups();
      for (const [key, group] of groups) {
        if (killing.has(key)) continue;
        const last = lastKillAt.get(key);
        if (last !== undefined && Date.now() - last < cfg.cooldownMs) continue;
        const hist = series.get(key) ?? [];
        const verdict = evaluate(key, group, hist, cfg);
        if (verdict) {
          lastKillAt.set(key, Date.now());
          appendEvent({ event: "trigger", agentId: group.agentId, pgid: group.pgid, ...verdict, rssMb: group.totalRssMb });
          executeKill(ctx, group, key, verdict);
        } else {
          series.set(key, hist);
        }
      }
    } catch {
      /* 采样失败下轮再来 */
    }
  };
  const schedule = () => {
    samplerTimer = setInterval(tick, Math.max(1000, readSettings().sampleIntervalMs));
  };
  schedule();
  // interval 周期随设置变化：每 60s 重排一次
  const rescheduler = setInterval(() => {
    clearInterval(samplerTimer);
    schedule();
  }, 60_000);
  rescheduler.unref?.();
  samplerTimer.unref?.();
}

const lastKillAt = new Map(); // groupKey → ts（冷却）

// ────────────────────────────── post-execute（附加「为什么被杀」警告） ──────────────────────────────

async function postExecuteHook(exec, result, next) {
  const downstream = await next();
  try {
    const cfg = readSettings();
    const agentId = exec?.agent?.id;
    if (!cfg.enabled || !agentId) return downstream;
    const kill = recentKills.get(agentId);
    if (!kill || Date.now() - kill.at > cfg.warnRecentWindowMs) return downstream;
    const text =
      `⚠️ [dsh-memguard] 刚刚内存守卫终止了你启动的进程组（pgid ${kill.event.pgid}，${kill.event.rssMb}MB，${kill.event.detail}）。` +
      "上面命令的非零退出/中断信号很可能由此导致：请按内存泄漏排查修复，不要原样重跑。可用 memguard_status 查看守卫事件。";
    return {
      ...downstream,
      additionalContexts: [{ type: "text", text }, ...(downstream?.additionalContexts ?? [])],
    };
  } catch {
    return downstream;
  }
}

// ────────────────────────────── 系统提示段 ──────────────────────────────

const PROMPT_SECTION = [
  "## 内存守卫（dsh-memguard）",
  "",
  "- 平台常驻一个内存守卫：它持续采样你启动的所有进程的内存（RSS）。若某进程内存持续异常增长或超过阈值（默认 1.5GB），守卫会**直接终止整个进程树**并向你插入 `[dsh-memguard]` 警告消息。",
  "- 收到该警告时：视对应命令为失败，先分析内存增长根因（无限缓存、未释放句柄/定时器、死循环追加、指数增长数据结构、一次性读入超大文件等），修复后再用小数据量验证；**不要原样重跑同一条命令**。",
  "- 长时间运行的脚本优先考虑流式处理与分批释放；后台任务用 job 工具托管，别让进程脱离跟踪。",
  "- 随时可用 `memguard_status` 查看守卫状态与最近事件。",
].join("\n");

// ────────────────────────────── memguard_status 工具 ──────────────────────────────

function statusPayload() {
  const cfg = readSettings();
  const groups = activeGroups();
  const recent = [];
  try {
    if (existsSync(EVENTS_FILE)) {
      const lines = readFileSync(EVENTS_FILE, "utf8").trim().split("\n");
      for (const line of lines.slice(-30)) {
        try { recent.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    }
  } catch { /* 读不到就空 */ }
  return {
    enabled: cfg.enabled,
    hostPid: process.pid,
    settings: cfg,
    defaults: { ...DEFAULTS }, // 设置面板的「恢复插件默认值」用它，避免两端各硬编码一份
    trackedPids: ledger.size,
    activeGroups: [...groups.values()].map((g) => ({
      agentId: g.agentId,
      pgid: g.pgid,
      rssMb: g.totalRssMb,
      pids: g.pids.size,
      command: String(g.topArgs ?? g.topComm ?? "?").slice(0, 200),
    })),
    recentEvents: recent.slice(-15),
  };
}

// ────────────────────────────── apply ──────────────────────────────

export function apply(ctx) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendEvent({ event: "boot", hostPid: process.pid });

  // 系统提示段（可关）
  ctx.effect(
    () => {
      const cfg = readSettings();
      if (cfg.notifySystemPrompt === false) return undefined;
      return ctx.systemPrompt.section({
        name: "dsh-memguard:notice",
        order: 3600,
        text: PROMPT_SECTION,
      });
    },
    "dsh-memguard: system prompt section",
  );

  // 工具执行环绕：窗口差集记账（归因）
  ctx.effect(
    () => ctx.on("tools/execute", executeHook),
    "dsh-memguard: tools/execute ledger hook",
  );

  // 工具结果后处理：近期被杀 → 附加解释
  ctx.effect(
    () => ctx.on("tools/post-execute", postExecuteHook),
    "dsh-memguard: tools/post-execute warn hook",
  );

  // memguard_status 工具
  ctx.effect(
    () =>
      ctx.tools.register({
        name: "memguard_status",
        description:
          "Show the memory guard (dsh-memguard) state: whether it is enabled, which agent process groups are currently tracked with their RSS, and recent kill/trigger events. Use it after a MEMGUARD warning to review what was terminated, or when a long-running task's memory behavior looks suspicious.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
          render: (_args, value) => [{ type: "text", text: value.text }],
        },
        async execute() {
          const s = statusPayload();
          const groups = s.activeGroups;
          const lines = [
            `dsh-memguard 状态：${s.enabled ? "启用" : "停用"} | host pid ${s.hostPid} | 跟踪进程 ${s.trackedPids} 个`,
            "",
            groups.length > 0
              ? "当前跟踪的进程组："
              : "当前没有正在跟踪的进程组。",
            ...groups.map(
              (g) => `- agent ${g.agentId} | pgid ${g.pgid} | ${g.rssMb}MB | ${g.pids} 个进程 | ${g.command}`,
            ),
          ];
          const kills = s.recentEvents.filter((e) => e.event === "trigger" || e.event === "kill");
          if (kills.length > 0) {
            lines.push("", "最近事件：");
            for (const e of kills.slice(-8)) {
              lines.push(`- [${e.at}] ${e.event} pgid ${e.pgid ?? "?"} agent ${e.agentId ?? "?"}：${e.detail ?? ""}（${e.rssMb ?? "?"}MB）`);
            }
          }
          return { text: lines.join("\n") };
        },
      }),
    "dsh-memguard: memguard_status tool",
  );

  // 状态路由（人类/诊断用）
  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          path: "/dsh-memguard",
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? "/", "http://localhost");
              // ⚠️ prefix 注册下 req.url 是**完整路径**（/dsh-memguard/settings），不是剥掉
              // 前缀后的剩余段。只认 "/settings" 会让 POST 静默落进 GET 分支——设置面板
              // 点保存看起来成功、实际一个字节都没写（实测 2026-09-27）。两种形态都收。
              const pathname = url.pathname.replace(/\/+$/, "");
              if (req.method === "POST" && (pathname === "/settings" || pathname.endsWith("/dsh-memguard/settings"))) {
                let body = "";
                req.on("data", (c) => (body += c));
                req.on("end", () => {
                  try {
                    const patch = sanitizeSettings(JSON.parse(body));
                    if (Object.keys(patch).length > 0) {
                      mkdirSync(STATE_DIR, { recursive: true });
                      const merged = { ...readSettings(), ...patch };
                      const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
                      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
                      renameSync(tmp, SETTINGS_FILE);
                      invalidateSettings();
                    }
                    reply(res, 200, statusPayload());
                  } catch (error) {
                    reply(res, 400, { error: String(error?.message ?? error) });
                  }
                });
                return;
              }
              reply(res, 200, statusPayload());
            } catch (error) {
              reply(res, 500, { error: String(error?.message ?? error) });
            }
          },
        }),
      "dsh-memguard: status route",
    );
  });

  // 采样器启动
  startSampler(ctx);
}

function reply(res, status, body) {
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 客户端已断开 */
  }
}
