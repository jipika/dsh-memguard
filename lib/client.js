// dsh-memguard — browser half：把守卫的关键参数搬进「设置 → 插件 → 内存守卫」。
//
// 数据通道全部复用 host 半边已有的两条路由，client 不新开协议：
//   GET  /dsh-memguard           → { enabled, settings, defaults, trackedPids,
//                                    activeGroups[], recentEvents[] }
//   POST /dsh-memguard/settings  → 合并写入 settings.json（host 侧 sanitize 钳制）
// host 是 live re-read + POST 后 invalidateSettings()，所以保存即时生效，
// 既不用重启应用，也不用重启守卫。
//
// 挂载：slot `settings.plugins.tab`。它的 id 必须等于**插件包名**——宿主在
// 「设置 → 插件」页是按插件清单行的 id 用 { only: row.id } 过滤渲染 tab 的，
// 写成别的字符串会落在一个永远不会被渲染的行上（点开空白）。
//
// 回滚：删掉 package.json 的 `dsh.client` 段与 exports["./client"]，
// 或直接本文件，重启应用即回到纯 host 插件。
window.__ModuleLoader__.load({
	id: "dsh-memguard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const API = "/dsh-memguard";
		const STYLE_ID = "dsh-memguard-style";

		/** 大项目友好档：就是给 Nuxt/Vite 这类冷启动爬到 1~2G 的构建留出空间。 */
		const BIG_PROJECT = {
			sampleIntervalMs: 5000,
			absThresholdMb: 4096,
			absConsecutive: 3,
			growthSamples: 12,
			growthDeltaMb: 1200,
			growthFloorMb: 1800,
		};

		/** 表单分组：meta 驱动渲染，字段顺序即界面顺序。 */
		const GROUPS = [
			{
				title: "绝对阈值",
				desc: "进程组总 RSS 超过阈值，且连续若干次采样仍然超标 → 终止整棵进程树。",
				fields: [
					{
						key: "absThresholdMb",
						label: "内存阈值",
						unit: "MB",
						min: 0,
						max: 262144,
						step: 128,
						hint: "16G 机器建议 4096（给项目留 4G）；填 0 关闭这条判定。",
					},
					{
						key: "absConsecutive",
						label: "连续超标次数",
						unit: "次",
						min: 1,
						max: 12,
						step: 1,
						hint: "防瞬时尖峰。3 次 × 5s = 连续 15 秒压不下来才动手。",
					},
				],
			},
			{
				title: "增长判定",
				desc: "窗口内 RSS 单调不降、累计涨幅超线、且当前水位已够高 → 视为失控增长。",
				fields: [
					{
						key: "growthSamples",
						label: "窗口采样点数",
						unit: "点",
						min: 2,
						max: 12,
						step: 1,
						hint: "硬上限 12（守卫内部只保留最近 12 个采样，填更大无效）。窗口时长 = 本值 × 采样间隔。",
					},
					{
						key: "growthDeltaMb",
						label: "涨幅阈值",
						unit: "MB",
						min: 0,
						max: 262144,
						step: 100,
						hint: "整个窗口内累计涨这么多才算异常；填 0 关闭增长判定。",
					},
					{
						key: "growthFloorMb",
						label: "最低水位",
						unit: "MB",
						min: 0,
						max: 262144,
						step: 100,
						hint: "当前 RSS 低于它就绝不按增长杀人——这是冷启动不被误杀的主要护栏。",
					},
				],
			},
			{
				title: "采样与冷却",
				desc: "采样越密发现越快、越费资源；冷却防止同一进程组被反复处置。",
				fields: [
					{
						key: "sampleIntervalMs",
						label: "采样间隔",
						unit: "ms",
						min: 1000,
						max: 60000,
						step: 500,
						hint: "每次采样是一次 ps 全表扫描（500ms 内去重）。",
					},
					{
						key: "cooldownMs",
						label: "处置冷却",
						unit: "ms",
						min: 0,
						max: 3600000,
						step: 5000,
						hint: "同一进程组两次处置之间的最小间隔。",
					},
					{
						key: "warnRecentWindowMs",
						label: "附加警告窗口",
						unit: "ms",
						min: 0,
						max: 600000,
						step: 5000,
						hint: "被杀后多久内，给该 agent 的工具结果附上「为什么非零退出」的解释。",
					},
				],
			},
		];

		const CSS = [
			".dsh-mg-root{max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary);padding-bottom:16px}",
			".dsh-mg-title{font-size:15px;font-weight:600;margin-bottom:6px}",
			".dsh-mg-lead{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);margin:0 0 14px}",
			".dsh-mg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:13px 16px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}",
			".dsh-mg-card-title{font-size:13px;font-weight:600}",
			".dsh-mg-card-desc{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin:3px 0 10px}",
			".dsh-mg-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 0}",
			".dsh-mg-row+.dsh-mg-row{border-top:.5px solid var(--dsw-alias-border-l1)}",
			".dsh-mg-row-main{min-width:0;flex:1 1 auto}",
			".dsh-mg-label{font-size:13px}",
			".dsh-mg-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:2px}",
			".dsh-mg-input-wrap{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
			".dsh-mg-input{width:110px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-variant-numeric:tabular-nums;text-align:right}",
			".dsh-mg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
			".dsh-mg-text{width:100%;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px}",
			".dsh-mg-unit{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:22px}",
			".dsh-mg-toggle{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer}",
			'.dsh-mg-toggle[data-on="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
			".dsh-mg-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px}",
			".dsh-mg-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}",
			".dsh-mg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}",
			'.dsh-mg-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
			".dsh-mg-btn:disabled{opacity:.5;cursor:default}",
			".dsh-mg-note{font-size:12px}",
			'.dsh-mg-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}',
			'.dsh-mg-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}',
			".dsh-mg-stats{display:flex;flex-wrap:wrap;gap:18px;margin-bottom:8px}",
			".dsh-mg-stat-num{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}",
			".dsh-mg-stat-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".dsh-mg-list{margin:0;padding:0;list-style:none;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
			".dsh-mg-list li{padding:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-mg-mono{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
			".dsh-mg-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}",
		].join("\n");

		function ensureStyle() {
			if (!document.head) return;
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			if (style.textContent !== CSS) style.textContent = CSS;
		}

		async function apiGet() {
			const res = await fetch(API, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function apiPostSettings(next) {
			const res = await fetch(`${API}/settings`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(next),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
			return data;
		}

		function num(value, fallback) {
			const n = Number(value);
			return Number.isFinite(n) ? n : fallback;
		}

		function listToText(value) {
			return Array.isArray(value) ? value.join(", ") : String(value ?? "");
		}

		function textToList(text) {
			return String(text ?? "")
				.split(/[,，\s]+/)
				.map((s) => s.trim())
				.filter(Boolean);
		}

		function fmtAge(iso) {
			const t = Date.parse(iso ?? "");
			if (!Number.isFinite(t)) return "";
			const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
			if (sec < 60) return `${sec} 秒前`;
			if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
			return `${Math.round(sec / 3600)} 小时前`;
		}

		/** 数字字段一行。 */
		function NumberRow(field, draft, setKey) {
			return h(
				"div",
				{ className: "dsh-mg-row", key: field.key },
				h(
					"div",
					{ className: "dsh-mg-row-main" },
					h("div", { className: "dsh-mg-label" }, field.label),
					h("div", { className: "dsh-mg-hint" }, field.hint),
				),
				h(
					"div",
					{ className: "dsh-mg-input-wrap" },
					h("input", {
						className: "dsh-mg-input",
						type: "number",
						inputMode: "numeric",
						min: field.min,
						max: field.max,
						step: field.step,
						value: draft[field.key] ?? "",
						"data-testid": `memguard-${field.key}`,
						onChange: (event) => setKey(field.key, event.target.value),
					}),
					h("span", { className: "dsh-mg-unit" }, field.unit),
				),
			);
		}

		/** 布尔字段一行（胶囊开关）。 */
		function ToggleRow(props) {
			const on = !!props.value;
			return h(
				"div",
				{ className: "dsh-mg-row" },
				h(
					"div",
					{ className: "dsh-mg-row-main" },
					h("div", { className: "dsh-mg-label" }, props.label),
					props.hint ? h("div", { className: "dsh-mg-hint" }, props.hint) : null,
				),
				h(
					"button",
					{
						type: "button",
						role: "switch",
						"aria-checked": on,
						"data-on": String(on),
						"data-testid": `memguard-${props.fieldKey}`,
						className: "dsh-mg-toggle",
						onClick: () => props.onChange(!on),
					},
					on ? "已开启" : "已关闭",
				),
			);
		}

		function MemguardSettings() {
			const [snap, setSnap] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [note, setNote] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const load = React.useCallback(async () => {
				try {
					const data = await apiGet();
					setSnap(data);
					// 只在首次（或保存后显式置空）灌入草稿，避免轮询把正在编辑的值冲掉
					setDraft((prev) => (prev === null ? { ...data.settings } : prev));
				} catch (error) {
					setNote({ kind: "error", text: `读取配置失败：${error?.message ?? error}` });
				}
			}, []);

			React.useEffect(() => {
				load();
				const timer = setInterval(load, 5000);
				return () => clearInterval(timer);
			}, [load]);

			const setKey = React.useCallback((key, value) => {
				setDraft((prev) => ({ ...(prev ?? {}), [key]: value }));
				setNote(null);
			}, []);

			const payloadOf = React.useCallback(
				(d) => ({
					enabled: !!d.enabled,
					sampleIntervalMs: num(d.sampleIntervalMs, 3000),
					absThresholdMb: num(d.absThresholdMb, 1536),
					absConsecutive: num(d.absConsecutive, 2),
					growthSamples: num(d.growthSamples, 5),
					growthDeltaMb: num(d.growthDeltaMb, 400),
					growthFloorMb: num(d.growthFloorMb, 600),
					cooldownMs: num(d.cooldownMs, 60000),
					notifySystemPrompt: !!d.notifySystemPrompt,
					warnRecentWindowMs: num(d.warnRecentWindowMs, 30000),
					excludeCommPatterns: textToList(d.excludeCommPatterns),
				}),
				[],
			);

			const save = async (override) => {
				const next = payloadOf(override ?? draft ?? {});
				setBusy(true);
				try {
					const data = await apiPostSettings(next);
					setSnap(data);
					setDraft({ ...(data?.settings ?? next) }); // 回填服务端钳制后的真值
					// 服务端可能原样返回（守卫还是旧版、或 POST 没匹配上路由）——比对一眼，
					// 否则面板会假装保存成功。这个 POST 历史上就曾被静默吞掉过。
					const applied = data?.settings ?? {};
					const drift = Object.keys(next).filter(
						(k) => JSON.stringify(applied[k]) !== JSON.stringify(next[k]),
					);
					setNote(
						drift.length === 0
							? { kind: "ok", text: "已保存，立即生效（无需重启）" }
							: {
									kind: "error",
									text: `已提交但服务端没接受（${drift.join("、")}）——宿主可能还在跑旧版守卫，重启 DSH 后重试`,
								},
					);
				} catch (error) {
					setNote({ kind: "error", text: `保存失败：${error?.message ?? error}` });
				} finally {
					setBusy(false);
				}
			};

			if (snap === null || draft === null) {
				return h(
					"div",
					{ className: "dsh-mg-root" },
					h("div", { className: "dsh-mg-title" }, "内存守卫"),
					h("div", { className: "dsh-mg-lead" }, "正在读取配置…"),
					note ? h("div", { className: "dsh-mg-note", "data-kind": note.kind }, note.text) : null,
				);
			}

			const groups = snap.activeGroups ?? [];
			const events = (snap.recentEvents ?? []).filter((e) => e.event === "trigger" || e.event === "kill");

			return h(
				"div",
				{ className: "dsh-mg-root" },
				h("div", { className: "dsh-mg-title" }, "内存守卫"),
				h(
					"div",
					{ className: "dsh-mg-lead" },
					"监控 agent 启动的每个进程组；内存失控时终止整棵进程树，并自动给发起任务的 agent 插一条警告，让它去修泄漏而不是原样重跑。",
				),

				// ── 总开关 ──
				h(
					"div",
					{ className: "dsh-mg-card" },
					h(ToggleRow, {
						fieldKey: "enabled",
						label: "启用守卫",
						hint: "关掉后停止采样与处置（记账也会停），正在运行的进程一律不动。",
						value: draft.enabled,
						onChange: (v) => setKey("enabled", v),
					}),
					h(ToggleRow, {
						fieldKey: "notifySystemPrompt",
						label: "向提示词注入守卫说明",
						hint: "关掉后模型不再收到「被杀的进程如何排查」那段系统提示。",
						value: draft.notifySystemPrompt,
						onChange: (v) => setKey("notifySystemPrompt", v),
					}),
				),

				// ── 预设 ──
				h(
					"div",
					{ className: "dsh-mg-card" },
					h("div", { className: "dsh-mg-card-title" }, "一键预设"),
					h(
						"div",
						{ className: "dsh-mg-card-desc" },
						"冷启动就能吃到 1~2G 的构建（Nuxt/Vite/Jest）用「大项目友好」；只想抓明显泄漏、完全不想被误杀就再抬高一档。",
					),
					h(
						"div",
						{ className: "dsh-mg-actions", style: { marginTop: 0 } },
						h(
							"button",
							{
								type: "button",
								className: "dsh-mg-btn",
								"data-testid": "memguard-preset-big",
								disabled: busy,
								onClick: () => setDraft((prev) => ({ ...prev, ...BIG_PROJECT })),
							},
							"大项目友好（推荐）",
						),
						h(
							"button",
							{
								type: "button",
								className: "dsh-mg-btn",
								"data-testid": "memguard-preset-default",
								disabled: busy,
								onClick: () => setDraft((prev) => ({ ...prev, ...(snap.defaults ?? {}) })),
							},
							"恢复插件默认值",
						),
					),
				),

				// ── 参数分组 ──
				...GROUPS.map((group) =>
					h(
						"div",
						{ className: "dsh-mg-card", key: group.title },
						h("div", { className: "dsh-mg-card-title" }, group.title),
						h("div", { className: "dsh-mg-card-desc" }, group.desc),
						...group.fields.map((field) => NumberRow(field, draft, setKey)),
					),
				),

				// ── 排除名单 ──
				h(
					"div",
					{ className: "dsh-mg-card" },
					h("div", { className: "dsh-mg-card-title" }, "排除名单"),
					h(
						"div",
						{ className: "dsh-mg-card-desc" },
						"命令名（comm）包含这些子串的进程永不记账、永不被处置。逗号或空格分隔，区分大小写。",
					),
					h("input", {
						className: "dsh-mg-text",
						type: "text",
						value: listToText(draft.excludeCommPatterns),
						"data-testid": "memguard-excludeCommPatterns",
						onChange: (event) => setKey("excludeCommPatterns", event.target.value),
					}),
				),

				// ── 保存 ──
				h(
					"div",
					{ className: "dsh-mg-actions" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-mg-btn",
							"data-primary": "true",
							"data-testid": "memguard-save",
							disabled: busy,
							onClick: () => save(),
						},
						busy ? "保存中…" : "保存",
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-mg-btn",
							disabled: busy,
							onClick: () => {
								setDraft({ ...snap.settings });
								setNote(null);
							},
						},
						"撤销改动",
					),
					note ? h("span", { className: "dsh-mg-note", "data-kind": note.kind }, note.text) : null,
				),

				// ── 实时状态 ──
				h(
					"div",
					{ className: "dsh-mg-card", style: { marginTop: 14 } },
					h("div", { className: "dsh-mg-card-title" }, "当前状态"),
					h(
						"div",
						{ className: "dsh-mg-stats", style: { marginTop: 10 } },
						h(
							"div",
							null,
							h("div", { className: "dsh-mg-stat-num" }, String(snap.trackedPids ?? 0)),
							h("div", { className: "dsh-mg-stat-label" }, "跟踪中的进程"),
						),
						h(
							"div",
							null,
							h("div", { className: "dsh-mg-stat-num" }, String(groups.length)),
							h("div", { className: "dsh-mg-stat-label" }, "活跃进程组"),
						),
					),
					groups.length === 0
						? h("div", { className: "dsh-mg-empty" }, "当前没有正在跟踪的进程组。")
						: h(
								"ul",
								{ className: "dsh-mg-list" },
								groups.slice(0, 6).map((g, i) =>
									h(
										"li",
										{ key: `${g.pgid}-${i}` },
										h("span", { className: "dsh-mg-mono" }, `${g.rssMb}MB`),
										` · ${g.pids} 个进程 · ${String(g.command ?? "").slice(0, 90)}`,
									),
								),
							),
					events.length > 0
						? h(
								"ul",
								{ className: "dsh-mg-list", style: { marginTop: 10 } },
								events.slice(-3).map((e, i) =>
									h(
										"li",
										{ key: `ev-${i}` },
										h("span", { className: "dsh-mg-mono" }, e.event === "kill" ? "已终止" : "触发"),
										` · ${fmtAge(e.at)} · ${e.rssMb ?? "?"}MB · ${e.detail ?? ""}`,
									),
								),
							)
						: null,
				),
			);
		}

		/** Browser half entry：把面板挂到「设置 → 插件」里本插件那一行的 tab 上。 */
		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("settings.plugins.tab", () =>
				ctx.slots.register(
					{
						name: "settings.plugins.tab",
						id: "dsh-memguard",
						order: 10,
						label: () => "内存守卫",
					},
					MemguardSettings,
				),
			);
		}

		exports.name = "dsh-memguard";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
