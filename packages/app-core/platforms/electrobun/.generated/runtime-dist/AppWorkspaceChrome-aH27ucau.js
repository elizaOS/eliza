import { D as require_jsx_runtime } from "./electrobun-runtime-zXJ9acDW.js";
import { d as client, h as STATUS_DOT, j as stripAssistantStageDirections, m as PULSE_STATUSES, n as useApp } from "./useApp-Dh-r7aR7.js";
import { Fn as fetchWithCsrf, Fr as useChatComposer, Gr as ttsDebug, Hi as ELIZA_CLOUD_STATUS_UPDATED_EVENT, Xi as VOICE_CONFIG_UPDATED_EVENT, da as resolveAppAssetUrl, dt as usePtySessions, ia as confirmDesktopAction, rt as isRoutineCodingAgentMessage, u as useCompanionSceneStatus, wn as getVrmPreviewUrl } from "./state-BC9WO-N8.js";
import { c as paramsToSchema } from "./plugin-list-utils-D3K7UKwI.js";
import { C as useVoiceChat, E as useChatAvatarVoiceBridge, T as resolveCharacterVoiceConfigFromAppConfig, d as useMediaQuery } from "./hooks-C3v9uETL.js";
import { ConfigFieldErrors, ConfigRenderer, defaultRegistry, getByPath, getConfigInputClassName, getConfigTextareaClassName, setByPath } from "./index.js";
import { Button, ChatAttachmentStrip, ChatComposer, ChatComposerShell, ChatSourceIcon, ChatThreadLayout, ChatTranscript, Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, TypingIndicator, WorkspaceMobileSidebarControlsContext, useDocumentVisibility, useIntervalWhenDocumentVisible, useTimeout } from "@elizaos/ui";
import { Check, LayoutDashboard, PanelLeftOpen, PanelRightClose, PanelRightOpen, RotateCcw, Sparkles } from "lucide-react";
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/app-shell/task-coordinator-slots.js
var import_jsx_runtime = require_jsx_runtime();
let registered = {};
function registerTaskCoordinatorSlots(components) {
	registered = {
		...registered,
		...components
	};
}
function CodingAgentSettingsSection(props) {
	const Component = registered.CodingAgentSettingsSection;
	return Component ? (0, import_jsx_runtime.jsx)(Component, { ...props }) : null;
}
function CodingAgentTasksPanel(props) {
	const Component = registered.CodingAgentTasksPanel;
	return Component ? (0, import_jsx_runtime.jsx)(Component, { ...props }) : null;
}
function CodingAgentControlChip(props) {
	const Component = registered.CodingAgentControlChip;
	return Component ? (0, import_jsx_runtime.jsx)(Component, { ...props }) : null;
}
function PtyConsoleBase(props) {
	const Component = registered.PtyConsoleBase;
	return Component ? (0, import_jsx_runtime.jsx)(Component, { ...props }) : null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/AgentActivityBox.js
/** Derive activity text for sessions hydrated from the server (no lastActivity yet). */
function deriveActivity(s, t) {
	if (s.status === "tool_running" && s.toolDescription) return t("agentactivitybox.RunningTool", {
		defaultValue: "Running {{tool}}",
		tool: s.toolDescription
	}).slice(0, 60);
	if (s.status === "blocked") return t("agentactivitybox.WaitingForInput", { defaultValue: "Waiting for input" });
	if (s.status === "error") return t("common.error", { defaultValue: "Error" });
	return t("appsview.Running", { defaultValue: "Running" });
}
function AgentActivityBox({ sessions, onSessionClick }) {
	const { t } = useApp();
	if (!sessions || sessions.length === 0) return null;
	return (0, import_jsx_runtime.jsx)("div", {
		className: "px-3 py-2 space-y-1 z-[1] mb-2 relative rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] shadow-[0_12px_36px_rgba(0,0,0,0.12)] ring-1 ring-inset ring-white/6 backdrop-blur-[22px]",
		children: sessions.map((s) => (0, import_jsx_runtime.jsxs)("button", {
			type: "button",
			onClick: () => onSessionClick?.(s.sessionId),
			className: "flex items-center gap-1.5 min-w-0 w-full text-left cursor-pointer hover:bg-bg-hover rounded px-1 -mx-1 transition-colors",
			children: [
				(0, import_jsx_runtime.jsx)("span", { className: `inline-block w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status] ?? "bg-muted"}${PULSE_STATUSES.has(s.status) ? " animate-pulse" : ""}` }),
				(0, import_jsx_runtime.jsx)("span", {
					className: "text-xs-tight font-medium text-txt max-w-[120px] truncate shrink-0",
					children: s.label
				}),
				(0, import_jsx_runtime.jsx)("span", {
					className: `text-xs-tight truncate min-w-0 flex-1 ${s.status === "error" ? "text-danger" : s.status === "blocked" ? "text-warn" : s.status === "active" || s.status === "tool_running" ? "text-ok" : "text-muted"}`,
					children: s.lastActivity ?? deriveActivity(s, t)
				}),
				(0, import_jsx_runtime.jsx)("svg", {
					width: "12",
					height: "12",
					viewBox: "0 0 24 24",
					fill: "none",
					"aria-hidden": "true",
					focusable: "false",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					className: "shrink-0 text-muted",
					children: (0, import_jsx_runtime.jsx)("path", { d: "M18 15l-6-6-6 6" })
				})
			]
		}, s.sessionId))
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/config-ui/ui-renderer.js
const UiContext = createContext(null);
const BLOCKED_LINK_PROTOCOLS = new Set([
	"javascript",
	"data",
	"vbscript",
	"file"
]);
function useUiCtx() {
	const ctx = useContext(UiContext);
	if (!ctx) throw new Error("UiRenderer context missing");
	return ctx;
}
function resolveProp(value, ctx) {
	if (value == null) return value;
	if (typeof value === "string" && value.startsWith("$data.")) {
		const path = value.slice(6);
		if (path.startsWith("$item/") && ctx.repeatItem) return ctx.repeatItem[path.slice(6)];
		return getByPath(ctx.state, path);
	}
	if (typeof value === "object" && "$path" in value) {
		const path = value.$path;
		if (path.startsWith("$item/") && ctx.repeatItem) return ctx.repeatItem[path.slice(6)];
		return getByPath(ctx.state, path);
	}
	if (typeof value === "object" && "$cond" in value) {
		const expr = value;
		const cond = expr.$cond;
		let result = false;
		if (cond.eq) {
			const [a, b] = cond.eq.map((v) => resolveProp(v, ctx));
			result = a === b;
		} else if (cond.neq) {
			const [a, b] = cond.neq.map((v) => resolveProp(v, ctx));
			result = a !== b;
		} else if (cond.gt) {
			const [a, b] = cond.gt.map((v) => resolveProp(v, ctx));
			result = Number(a) > Number(b);
		} else if (cond.lt) {
			const [a, b] = cond.lt.map((v) => resolveProp(v, ctx));
			result = Number(a) < Number(b);
		} else if (cond.truthy) result = !!resolveProp(cond.truthy, ctx);
		else if (cond.falsy) result = !resolveProp(cond.falsy, ctx);
		else if (cond.path) result = !!getByPath(ctx.state, cond.path);
		return result ? resolveProp(expr.$then, ctx) : resolveProp(expr.$else, ctx);
	}
	if (typeof value === "object" && value !== null && "path" in value) {
		const p = value.path;
		if (p.startsWith("$item/") && ctx.repeatItem) return ctx.repeatItem[p.slice(6)];
		return getByPath(ctx.state, p);
	}
	return value;
}
function resolveProps(props, ctx) {
	const resolved = {};
	for (const [k, v] of Object.entries(props)) resolved[k] = resolveProp(v, ctx);
	return resolved;
}
function evaluateUiVisibility(condition, state, auth) {
	if (!condition) return true;
	if ("path" in condition && "operator" in condition) {
		const val = getByPath(state, condition.path);
		const target = condition.value;
		switch (condition.operator) {
			case "eq": return val === target;
			case "ne": return val !== target;
			case "gt": return Number(val) > Number(target);
			case "gte": return Number(val) >= Number(target);
			case "lt": return Number(val) < Number(target);
			case "lte": return Number(val) <= Number(target);
			default: return true;
		}
	}
	if ("auth" in condition) {
		if (!auth) return false;
		switch (condition.auth) {
			case "signedIn": return auth.isSignedIn;
			case "signedOut": return !auth.isSignedIn;
			case "admin": return auth.roles?.includes("admin") ?? false;
			default: return auth.roles?.includes(condition.auth) ?? false;
		}
	}
	if ("and" in condition) return condition.and.every((c) => evaluateUiVisibility(c, state, auth));
	if ("or" in condition) return condition.or.some((c) => evaluateUiVisibility(c, state, auth));
	if ("not" in condition) return !evaluateUiVisibility(condition.not, state, auth);
	return true;
}
function sanitizeLinkHref(href) {
	const raw = String(href ?? "#").trim().replace(/[\t\n\r]/g, "");
	if (!raw) return "#";
	if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("?")) return raw;
	const match = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(raw);
	if (!match) return raw;
	const protocol = match[1].toLowerCase();
	if (BLOCKED_LINK_PROTOCOLS.has(protocol)) return "#";
	return raw;
}
const BUILTIN_VALIDATORS = {
	required: (v) => v != null && v !== "",
	email: (v) => typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
	minLength: (v, args) => typeof v === "string" && v.length >= Number(args?.length ?? 0),
	maxLength: (v, args) => typeof v === "string" && v.length <= Number(args?.length ?? Infinity),
	pattern: (v, args) => {
		if (typeof v !== "string" || !args?.pattern) return true;
		try {
			return new RegExp(String(args.pattern)).test(v);
		} catch {
			return true;
		}
	},
	min: (v, args) => Number(v) >= Number(args?.value ?? -Infinity),
	max: (v, args) => Number(v) <= Number(args?.value ?? Infinity)
};
function runValidation(checks, value, customValidators) {
	const errors = [];
	for (const check of checks) {
		const fn = BUILTIN_VALIDATORS[check.fn] ?? customValidators?.[check.fn];
		if (fn) {
			if (fn(value, check.args) === false) errors.push(check.message);
		}
	}
	return errors;
}
function useStatePath(statePath, ctx) {
	return [statePath ? getByPath(ctx.state, statePath) : void 0, useCallback((v) => {
		if (statePath) ctx.setState(statePath, v);
	}, [statePath, ctx])];
}
function fireEvent(action, ctx) {
	if (!action) return;
	const execute = () => {
		if (action.action === "setState" && action.params) {
			const p = action.params;
			ctx.setState(p.path, p.value);
			if (action.onSuccess && ctx.onAction) ctx.onAction(action.onSuccess.action, action.onSuccess.params);
		} else if (ctx.onAction) try {
			ctx.onAction(action.action, action.params);
			if (action.onSuccess) ctx.onAction(action.onSuccess.action, action.onSuccess.params);
		} catch {
			if (action.onError && ctx.onAction) ctx.onAction(action.onError.action, action.onError.params);
		}
	};
	(async () => {
		if (action.confirm) {
			if (!await confirmDesktopAction({
				title: action.confirm.title,
				message: action.confirm.message ?? "",
				confirmLabel: "Confirm",
				cancelLabel: "Cancel",
				type: "question"
			})) return;
		}
		execute();
	})();
}
const GAP = {
	none: "gap-0",
	xs: "gap-0.5",
	sm: "gap-1.5",
	md: "gap-3",
	lg: "gap-5",
	xl: "gap-8"
};
const ALIGN = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	stretch: "items-stretch"
};
const JUSTIFY = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	between: "justify-between",
	around: "justify-around"
};
const StackComponent = (props, children) => {
	return (0, import_jsx_runtime.jsx)("div", {
		className: `flex ${props.direction === "horizontal" ? "flex-row" : "flex-col"} ${GAP[String(props.gap ?? "md")] ?? "gap-3"} ${ALIGN[String(props.align ?? "stretch")] ?? ""} ${JUSTIFY[String(props.justify ?? "start")] ?? ""}`,
		children
	});
};
const GridComponent = (props, children) => {
	const cols = Number(props.columns ?? 2);
	return (0, import_jsx_runtime.jsx)("div", {
		className: `grid ${GAP[String(props.gap ?? "md")] ?? "gap-3"}`,
		style: { gridTemplateColumns: `repeat(${cols}, 1fr)` },
		children
	});
};
const CardComponent = (props, children) => {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `border border-border bg-card p-4 ${props.maxWidth === "full" ? "max-w-full" : ""}`,
		children: [
			props.title ? (0, import_jsx_runtime.jsx)("div", {
				className: "font-bold text-sm mb-0.5",
				children: String(props.title)
			}) : null,
			props.description ? (0, import_jsx_runtime.jsx)("div", {
				className: "text-xs text-muted mb-3",
				children: String(props.description)
			}) : null,
			children
		]
	});
};
const SeparatorComponent = (props) => {
	return props.orientation === "vertical" ? (0, import_jsx_runtime.jsx)("div", { className: "w-px bg-border self-stretch" }) : (0, import_jsx_runtime.jsx)("hr", { className: "my-2" });
};
const HeadingComponent = (props) => {
	const text = String(props.text ?? "");
	const level = String(props.level ?? "h2");
	return (0, import_jsx_runtime.jsx)("div", {
		className: level === "h1" ? "text-xl font-bold" : level === "h3" ? "text-sm font-bold" : "text-base font-bold",
		children: text
	});
};
const TextComponent = (props) => {
	const text = String(props.text ?? "");
	return (0, import_jsx_runtime.jsx)("div", {
		className: {
			body: "text-sm",
			caption: "text-xs text-muted",
			muted: "text-sm text-muted",
			lead: "text-sm font-medium",
			code: "text-xs font-mono bg-[var(--bg-hover)] px-1.5 py-0.5 border border-border"
		}[String(props.variant ?? "body")] ?? "text-sm",
		children: text
	});
};
const InputComponent = (props, _children, ctx, el) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const sp = props.statePath;
	const errors = sp ? ctx.fieldErrors?.[sp] : void 0;
	const validateOn = el.validation?.validateOn ?? "blur";
	const handleChange = (v) => {
		setValue(v);
		if (validateOn === "change" && sp && ctx.validateField) ctx.validateField(sp);
	};
	const handleBlur = () => {
		if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [
			props.label ? (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs font-semibold",
				children: String(props.label)
			}) : null,
			(0, import_jsx_runtime.jsx)("input", {
				className: getConfigInputClassName({
					density: "compact",
					hasError: !!errors?.length
				}),
				type: String(props.type ?? "text"),
				name: String(props.name ?? ""),
				placeholder: String(props.placeholder ?? ""),
				value: String(value ?? ""),
				onChange: (e) => handleChange(e.target.value),
				onBlur: handleBlur
			}),
			(0, import_jsx_runtime.jsx)(ConfigFieldErrors, { errors })
		]
	});
};
const TextareaComponent = (props, _children, ctx, el) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const sp = props.statePath;
	const errors = sp ? ctx.fieldErrors?.[sp] : void 0;
	const validateOn = el.validation?.validateOn ?? "blur";
	const handleChange = (v) => {
		setValue(v);
		if (validateOn === "change" && sp && ctx.validateField) ctx.validateField(sp);
	};
	const handleBlur = () => {
		if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [
			props.label ? (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs font-semibold",
				children: String(props.label)
			}) : null,
			(0, import_jsx_runtime.jsx)("textarea", {
				className: getConfigTextareaClassName({
					density: "compact",
					hasError: !!errors?.length
				}),
				name: String(props.name ?? ""),
				placeholder: String(props.placeholder ?? ""),
				rows: Number(props.rows ?? 3),
				value: String(value ?? ""),
				onChange: (e) => handleChange(e.target.value),
				onBlur: handleBlur
			}),
			(0, import_jsx_runtime.jsx)(ConfigFieldErrors, { errors })
		]
	});
};
const SelectComponent = (props, _children, ctx, el) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const options = props.options ?? [];
	const sp = props.statePath;
	const errors = sp ? ctx.fieldErrors?.[sp] : void 0;
	const validateOn = el.validation?.validateOn ?? "blur";
	const handleChange = (v) => {
		setValue(v);
		if (validateOn === "change" && sp && ctx.validateField) ctx.validateField(sp);
	};
	const handleBlur = () => {
		if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [
			props.label ? (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs font-semibold",
				children: String(props.label)
			}) : null,
			(0, import_jsx_runtime.jsxs)(Select, {
				value: String(value ?? "") || "__none__",
				onValueChange: (v) => {
					handleChange(v === "__none__" ? "" : v);
					handleBlur();
				},
				children: [(0, import_jsx_runtime.jsx)(SelectTrigger, {
					className: getConfigInputClassName({
						density: "compact",
						hasError: !!errors?.length
					}),
					children: (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: props.placeholder ? String(props.placeholder) : void 0 })
				}), (0, import_jsx_runtime.jsxs)(SelectContent, { children: [props.placeholder ? (0, import_jsx_runtime.jsx)(SelectItem, {
					value: "__none__",
					children: String(props.placeholder)
				}) : null, options.filter((o) => o.value !== "").map((o) => (0, import_jsx_runtime.jsx)(SelectItem, {
					value: o.value,
					children: o.label
				}, o.value))] })]
			}),
			(0, import_jsx_runtime.jsx)(ConfigFieldErrors, { errors })
		]
	});
};
const CheckboxComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2 text-xs cursor-pointer",
		children: [(0, import_jsx_runtime.jsx)(Checkbox, {
			checked: !!value,
			onCheckedChange: (checked) => setValue(!!checked)
		}), (0, import_jsx_runtime.jsx)("span", {
			className: "font-semibold",
			children: String(props.label ?? "")
		})]
	});
};
const RadioComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const options = props.options ?? [];
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [props.label ? (0, import_jsx_runtime.jsx)("span", {
			className: "text-xs font-semibold mb-0.5",
			children: String(props.label)
		}) : null, options.map((o) => (0, import_jsx_runtime.jsxs)("span", {
			className: "flex items-center gap-2 text-xs cursor-pointer",
			children: [(0, import_jsx_runtime.jsx)("input", {
				type: "radio",
				name: String(props.name ?? ""),
				value: o.value,
				checked: value === o.value,
				onChange: () => setValue(o.value)
			}), (0, import_jsx_runtime.jsx)("span", { children: o.label })]
		}, o.value))]
	});
};
const SwitchComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const checked = !!value;
	return (0, import_jsx_runtime.jsxs)("span", {
		className: "flex items-center gap-2 cursor-pointer",
		children: [(0, import_jsx_runtime.jsx)(Button, {
			type: "button",
			variant: "ghost",
			className: `relative w-9 h-[18px] p-0 transition-colors rounded-none ${checked ? "bg-accent" : "bg-muted"}`,
			onClick: () => setValue(!checked),
			children: (0, import_jsx_runtime.jsx)("div", { className: `absolute top-0.5 w-[14px] h-[14px] bg-card transition-all ${checked ? "left-5" : "left-0.5"}` })
		}), (0, import_jsx_runtime.jsx)("span", {
			className: "text-xs font-semibold",
			children: String(props.label ?? "")
		})]
	});
};
const SliderComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [props.label ? (0, import_jsx_runtime.jsxs)("div", {
			className: "flex justify-between text-xs",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "font-semibold",
				children: String(props.label)
			}), (0, import_jsx_runtime.jsx)("span", {
				className: "text-muted",
				children: String(value ?? props.min ?? 0)
			})]
		}) : null, (0, import_jsx_runtime.jsx)("input", {
			type: "range",
			min: Number(props.min ?? 0),
			max: Number(props.max ?? 100),
			step: Number(props.step ?? 1),
			value: Number(value ?? props.min ?? 0),
			onChange: (e) => setValue(Number(e.target.value)),
			className: "w-full",
			style: { accentColor: "var(--accent)" }
		})]
	});
};
const ToggleComponent = (props, _children, ctx, el) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const pressed = !!value;
	return (0, import_jsx_runtime.jsx)(Button, {
		type: "button",
		variant: pressed ? "default" : "outline",
		className: `px-3 py-1.5 text-xs transition-colors ${pressed ? "bg-accent text-accent-fg border-accent" : "bg-card text-txt hover:bg-[var(--bg-hover)]"}`,
		onClick: () => {
			setValue(!pressed);
			fireEvent(el.on?.press, ctx);
		},
		children: String(props.label ?? "Toggle")
	});
};
const ToggleGroupComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const items = props.items ?? [];
	const isMultiple = props.type === "multiple";
	const selected = new Set(Array.isArray(value) ? value : []);
	const toggle = (v) => {
		if (isMultiple) {
			const next = new Set(selected);
			if (next.has(v)) next.delete(v);
			else next.add(v);
			setValue([...next]);
		} else setValue(v);
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex gap-1",
		children: items.map((item) => {
			const active = isMultiple ? selected.has(item.value) : value === item.value;
			return (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: active ? "default" : "outline",
				className: `px-2.5 py-1 text-xs transition-colors ${active ? "bg-accent text-accent-fg border-accent" : "bg-card text-txt hover:bg-[var(--bg-hover)]"}`,
				onClick: () => toggle(item.value),
				children: item.label
			}, item.value);
		})
	});
};
const ButtonGroupComponent = (props, _children, ctx) => {
	const [value, setValue] = useStatePath(props.statePath, ctx);
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex gap-1",
		children: (props.buttons ?? []).map((btn) => {
			const active = value === btn.value;
			return (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: active ? "default" : "outline",
				className: `px-3 py-1.5 text-xs transition-colors ${active ? "bg-accent text-accent-fg border-accent" : "bg-card text-txt hover:bg-[var(--bg-hover)]"}`,
				onClick: () => setValue(btn.value),
				children: btn.label
			}, btn.value);
		})
	});
};
const TableComponent = (props) => {
	const columns = props.columns ?? [];
	const rows = props.rows ?? [];
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "overflow-x-auto",
		children: [props.caption ? (0, import_jsx_runtime.jsx)("div", {
			className: "text-xs font-semibold mb-1.5",
			children: String(props.caption)
		}) : null, (0, import_jsx_runtime.jsxs)("table", {
			className: "w-full text-xs border-collapse",
			children: [(0, import_jsx_runtime.jsx)("thead", { children: (0, import_jsx_runtime.jsx)("tr", { children: columns.map((col) => (0, import_jsx_runtime.jsx)("th", {
				className: "text-left px-2.5 py-1.5 font-semibold text-muted",
				children: col
			}, col)) }) }), (0, import_jsx_runtime.jsx)("tbody", { children: rows.map((row) => (0, import_jsx_runtime.jsx)("tr", {
				className: "",
				children: row.map((cell) => (0, import_jsx_runtime.jsx)("td", {
					className: "px-2.5 py-1.5",
					children: cell
				}, cell))
			}, row.join("|"))) })]
		})]
	});
};
const CarouselComponent = (props) => {
	const { t } = useApp();
	const items = props.items ?? [];
	const [current, setCurrent] = useState(0);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "relative",
		children: [(0, import_jsx_runtime.jsx)("div", {
			className: "border border-border bg-[var(--bg-hover)] p-4 min-h-[60px]",
			children: items[current] && (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("div", {
				className: "text-xs font-bold",
				children: items[current].title
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "text-xs text-muted mt-0.5",
				children: items[current].description
			})] })
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex justify-center gap-2 mt-2",
			children: [
				(0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "outline",
					size: "sm",
					className: "text-xs px-2 py-0.5",
					onClick: () => setCurrent((p) => Math.max(0, p - 1)),
					disabled: current === 0,
					children: t("ui-renderer.Larr")
				}),
				(0, import_jsx_runtime.jsxs)("span", {
					className: "text-2xs text-muted self-center",
					children: [
						current + 1,
						" / ",
						items.length
					]
				}),
				(0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "outline",
					size: "sm",
					className: "text-xs px-2 py-0.5",
					onClick: () => setCurrent((p) => Math.min(items.length - 1, p + 1)),
					disabled: current === items.length - 1,
					children: t("ui-renderer.Rarr")
				})
			]
		})]
	});
};
const BadgeComponent = (props) => {
	const variant = String(props.variant ?? "default");
	const cls = {
		default: "bg-[var(--surface)] text-txt border-border",
		success: "bg-[rgba(22,163,106,0.1)] text-ok border-ok",
		warning: "bg-[rgba(243,156,18,0.1)] text-[var(--warn,#f39c12)] border-[var(--warn,#f39c12)]",
		error: "bg-[rgba(231,76,60,0.1)] text-destructive border-destructive",
		info: "bg-[rgba(52,152,219,0.1)] text-accent border-accent"
	};
	return (0, import_jsx_runtime.jsx)("span", {
		className: `inline-block text-2xs font-medium px-2 py-0.5 border ${cls[variant] ?? cls.default}`,
		children: String(props.text ?? "")
	});
};
const AvatarComponent = (props) => {
	const name = String(props.name ?? "?");
	const size = props.size === "lg" ? "w-10 h-10 text-sm" : props.size === "sm" ? "w-6 h-6 text-2xs" : "w-8 h-8 text-xs";
	const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
	return (0, import_jsx_runtime.jsx)("div", {
		className: `${size} rounded-full bg-accent text-accent-fg flex items-center justify-center font-bold shrink-0`,
		children: initials
	});
};
const ImageComponent = (props) => {
	const src = props.src;
	const resolvedSrc = src ? resolveAppAssetUrl(src) : void 0;
	const alt = String(props.alt ?? "");
	const w = props.width ? `${props.width}px` : "auto";
	const h = props.height ? `${props.height}px` : "auto";
	return resolvedSrc ? (0, import_jsx_runtime.jsx)("img", {
		src: resolvedSrc,
		alt,
		style: {
			width: w,
			height: h
		},
		className: "object-cover border border-border"
	}) : (0, import_jsx_runtime.jsx)("div", {
		className: "bg-[var(--bg-hover)] border border-border flex items-center justify-center text-xs text-muted",
		style: {
			width: w,
			height: h
		},
		children: alt || "Image"
	});
};
const AlertComponent = (props) => {
	const type = String(props.type ?? "info");
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `border-l-[3px] ${{
			info: "border-accent",
			success: "border-ok",
			warning: "border-[var(--warn,#f39c12)]",
			error: "border-destructive"
		}[type] ?? ""} bg-[var(--bg-hover)] px-3 py-2`,
		children: [props.title ? (0, import_jsx_runtime.jsx)("div", {
			className: `text-xs font-bold ${{
				info: "text-accent",
				success: "text-ok",
				warning: "text-[var(--warn,#f39c12)]",
				error: "text-destructive"
			}[type] ?? ""}`,
			children: String(props.title)
		}) : null, props.message ? (0, import_jsx_runtime.jsx)("div", {
			className: "text-xs text-txt mt-0.5",
			children: String(props.message)
		}) : null]
	});
};
const ProgressComponent = (props) => {
	const value = Number(props.value ?? 0);
	const max = Number(props.max ?? 100);
	const pct = Math.min(100, Math.max(0, value / max * 100));
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [props.label ? (0, import_jsx_runtime.jsxs)("div", {
			className: "flex justify-between text-xs",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "font-semibold",
				children: String(props.label)
			}), (0, import_jsx_runtime.jsxs)("span", {
				className: "text-muted",
				children: [Math.round(pct), "%"]
			})]
		}) : null, (0, import_jsx_runtime.jsx)("div", {
			className: "w-full h-2 bg-[var(--bg-hover)] border border-border overflow-hidden",
			children: (0, import_jsx_runtime.jsx)("div", {
				className: "h-full bg-accent transition-[width] duration-300",
				style: { width: `${pct}%` }
			})
		})]
	});
};
const RatingComponent = (props) => {
	const value = Number(props.value ?? 0);
	const max = Number(props.max ?? 5);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-1",
		children: [props.label ? (0, import_jsx_runtime.jsx)("div", {
			className: "text-xs font-semibold",
			children: String(props.label)
		}) : null, (0, import_jsx_runtime.jsx)("div", {
			className: "flex gap-0.5",
			children: Array.from({ length: max }, (_, i) => i + 1).map((starValue) => (0, import_jsx_runtime.jsx)("span", {
				className: `text-sm ${starValue <= value ? "text-[var(--warn,#f39c12)]" : "text-muted opacity-30"}`,
				children: "★"
			}, starValue))
		})]
	});
};
const SkeletonComponent = (props) => {
	const w = props.width ? String(props.width) : "100%";
	const h = props.height ? String(props.height) : "20px";
	return (0, import_jsx_runtime.jsx)("div", {
		className: `bg-[var(--bg-hover)] animate-pulse ${props.rounded ? "rounded" : ""}`,
		style: {
			width: w,
			height: h
		}
	});
};
const SpinnerComponent = (props) => {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2",
		children: [(0, import_jsx_runtime.jsx)("div", { className: `${props.size === "lg" ? "w-8 h-8" : props.size === "sm" ? "w-4 h-4" : "w-6 h-6"} border-2 border-border border-t-accent rounded-full animate-spin` }), props.label ? (0, import_jsx_runtime.jsx)("span", {
			className: "text-xs text-muted",
			children: String(props.label)
		}) : null]
	});
};
const ButtonComponent = (props, _children, ctx, el) => {
	const variant = String(props.variant ?? "primary");
	const cls = {
		primary: "bg-accent text-accent-fg border-accent hover:opacity-90",
		secondary: "bg-card text-txt border-border hover:bg-[var(--bg-hover)]",
		danger: "bg-destructive text-white border-destructive hover:opacity-90",
		ghost: "bg-transparent text-txt border-transparent hover:bg-[var(--bg-hover)]"
	};
	return (0, import_jsx_runtime.jsx)(Button, {
		type: "button",
		variant: variant === "danger" ? "destructive" : variant === "ghost" ? "ghost" : variant === "secondary" ? "outline" : "default",
		className: `px-3 py-1.5 text-xs font-medium transition-colors ${cls[variant] ?? cls.primary}`,
		disabled: !!props.disabled,
		onClick: () => fireEvent(el.on?.press, ctx),
		children: String(props.label ?? "Button")
	});
};
const LinkComponent = (props, _children, ctx, el) => {
	return (0, import_jsx_runtime.jsx)("a", {
		href: sanitizeLinkHref(props.href),
		className: "text-xs text-accent underline hover:opacity-80",
		target: props.external ? "_blank" : void 0,
		rel: props.external ? "noopener noreferrer" : void 0,
		onClick: (e) => {
			if (el.on?.press) {
				e.preventDefault();
				fireEvent(el.on.press, ctx);
			}
		},
		children: String(props.label ?? props.href ?? "Link")
	});
};
const DropdownMenuComponent = (props, _children, ctx) => {
	const [open, setOpen] = useState(false);
	const items = props.items ?? [];
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "relative inline-block",
		children: [(0, import_jsx_runtime.jsxs)(Button, {
			type: "button",
			variant: "outline",
			size: "sm",
			className: "px-3 py-1.5 text-xs",
			onClick: () => setOpen(!open),
			children: [String(props.label ?? "Menu"), " ▾"]
		}), open && (0, import_jsx_runtime.jsx)("div", {
			className: "absolute top-full left-0 mt-1 min-w-[120px] border border-border bg-card shadow-md z-10",
			children: items.map((item) => (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "ghost",
				className: "block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)] rounded-none justify-start h-auto",
				onClick: () => {
					setOpen(false);
					if (ctx.onAction) ctx.onAction("menuSelect", {
						value: item.value,
						label: item.label
					});
				},
				children: item.label
			}, item.value))
		})]
	});
};
const TabsComponent = (props, _children, ctx) => {
	const tabs = props.tabs ?? [];
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const active = String(value ?? props.defaultValue ?? tabs[0]?.value ?? "");
	const activeTab = tabs.find((t) => t.value === active);
	return (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("div", {
		className: "flex",
		children: tabs.map((tab) => (0, import_jsx_runtime.jsx)(Button, {
			type: "button",
			variant: "ghost",
			className: `px-3 py-1.5 text-xs rounded-none transition-colors h-auto ${tab.value === active ? "border-b-2 border-accent text-accent font-semibold" : "text-muted hover:text-txt"}`,
			onClick: () => setValue(tab.value),
			children: tab.label
		}, tab.value))
	}), activeTab && (0, import_jsx_runtime.jsx)("div", {
		className: "py-3 text-xs",
		children: activeTab.content
	})] });
};
const PaginationComponent = (props, _children, ctx) => {
	const total = Number(props.totalPages ?? 1);
	const [value, setValue] = useStatePath(props.statePath, ctx);
	const current = Number(value ?? 1);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-1",
		children: [
			(0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "outline",
				size: "sm",
				className: "px-2 py-1 text-xs disabled:opacity-40",
				disabled: current <= 1,
				onClick: () => setValue(current - 1),
				children: "←"
			}),
			Array.from({ length: total }, (_, i) => i + 1).map((page) => (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: page === current ? "default" : "outline",
				size: "sm",
				className: `px-2 py-1 text-xs ${page === current ? "bg-accent text-accent-fg border-accent" : "hover:bg-[var(--bg-hover)]"}`,
				onClick: () => setValue(page),
				children: page
			}, page)),
			(0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "outline",
				size: "sm",
				className: "px-2 py-1 text-xs disabled:opacity-40",
				disabled: current >= total,
				onClick: () => setValue(current + 1),
				children: "→"
			})
		]
	});
};
const MetricComponent = (props) => {
	const trend = props.trend;
	const trendColor = trend === "up" ? "text-status-success" : trend === "down" ? "text-status-danger" : "text-muted";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-0.5 p-3 rounded-lg border border-border bg-card",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-2xs text-muted uppercase tracking-wider font-medium",
				children: String(props.label ?? "")
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-baseline gap-1.5",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "text-xl font-semibold text-[var(--txt)]",
					children: props.value != null ? String(props.value) : "—"
				}), props.unit != null && (0, import_jsx_runtime.jsx)("span", {
					className: "text-xs text-muted",
					children: String(props.unit)
				})]
			}),
			props.change != null && (0, import_jsx_runtime.jsx)("div", {
				className: `text-xs-tight font-medium ${trendColor}`,
				children: String(props.change)
			})
		]
	});
};
const BarGraphComponent = (props) => {
	const data = props.data ?? [];
	const maxVal = Math.max(...data.map((d) => d.value), 1);
	return (0, import_jsx_runtime.jsxs)("div", { children: [props.title ? (0, import_jsx_runtime.jsx)("div", {
		className: "text-xs font-bold mb-2",
		children: String(props.title)
	}) : null, (0, import_jsx_runtime.jsx)("div", {
		className: "flex items-end gap-2 h-[100px]",
		children: data.map((d) => (0, import_jsx_runtime.jsxs)("div", {
			className: "flex-1 flex flex-col items-center gap-0.5",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-3xs text-muted",
					children: d.value
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "w-full bg-accent transition-all duration-300 min-h-[2px]",
					style: { height: `${d.value / maxVal * 80}px` }
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-3xs text-muted truncate max-w-full",
					children: d.label
				})
			]
		}, d.label))
	})] });
};
const LineGraphComponent = (props) => {
	const data = props.data ?? [];
	const maxVal = Math.max(...data.map((d) => d.value), 1);
	const h = 80;
	const w = 100;
	const points = data.map((d, i) => ({
		x: i / Math.max(data.length - 1, 1) * w,
		y: h - d.value / maxVal * h
	}));
	const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
	return (0, import_jsx_runtime.jsxs)("div", { children: [props.title ? (0, import_jsx_runtime.jsx)("div", {
		className: "text-xs font-bold mb-2",
		children: String(props.title)
	}) : null, (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: `0 0 ${w} ${h + 20}`,
		className: "w-full h-[100px]",
		preserveAspectRatio: "none",
		children: [
			(0, import_jsx_runtime.jsx)("title", { children: String(props.title ?? "Line graph") }),
			(0, import_jsx_runtime.jsx)("path", {
				d: pathD,
				fill: "none",
				stroke: "var(--accent)",
				strokeWidth: "2",
				vectorEffect: "non-scaling-stroke"
			}),
			points.map((p) => (0, import_jsx_runtime.jsx)("circle", {
				cx: p.x,
				cy: p.y,
				r: "3",
				fill: "var(--accent)",
				vectorEffect: "non-scaling-stroke"
			}, `${p.x}:${p.y}`)),
			data.map((d, i) => (0, import_jsx_runtime.jsx)("text", {
				x: points[i].x,
				y: h + 14,
				textAnchor: "middle",
				fontSize: "8",
				fill: "var(--muted)",
				children: d.label
			}, `${d.label}:${d.value}`))
		]
	})] });
};
const TooltipComponent = (props) => {
	const [show, setShow] = useState(false);
	return (0, import_jsx_runtime.jsxs)(Button, {
		type: "button",
		variant: "ghost",
		className: "relative inline-block p-0 h-auto",
		onMouseEnter: () => setShow(true),
		onMouseLeave: () => setShow(false),
		onFocus: () => setShow(true),
		onBlur: () => setShow(false),
		onClick: () => setShow((prev) => !prev),
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "text-xs text-accent underline cursor-help",
			children: String(props.text ?? "Hover")
		}), show && (0, import_jsx_runtime.jsx)("div", {
			className: "absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-2xs bg-txt text-card whitespace-nowrap z-10",
			children: String(props.content ?? "")
		})]
	});
};
const PopoverComponent = (props) => {
	const [open, setOpen] = useState(false);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "relative inline-block",
		children: [(0, import_jsx_runtime.jsx)(Button, {
			type: "button",
			variant: "link",
			className: "text-xs text-accent underline p-0 h-auto",
			onClick: () => setOpen(!open),
			children: String(props.trigger ?? "Click")
		}), open && (0, import_jsx_runtime.jsxs)("div", {
			className: "absolute top-full left-0 mt-1 p-3 border border-border bg-card shadow-md z-10 min-w-[150px]",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "text-xs",
				children: String(props.content ?? "")
			}), (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "text-2xs text-muted mt-1 hover:text-txt p-0 h-auto",
				onClick: () => setOpen(false),
				children: "Close"
			})]
		})]
	});
};
const CollapsibleComponent = (props, children) => {
	const [open, setOpen] = useState(!!props.defaultOpen);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "border border-border",
		children: [(0, import_jsx_runtime.jsxs)(Button, {
			type: "button",
			variant: "ghost",
			className: "w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-[var(--bg-hover)] transition-colors rounded-none justify-start h-auto",
			onClick: () => setOpen(!open),
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "text-2xs transition-transform",
				style: { transform: open ? "rotate(90deg)" : "none" },
				children: "▶"
			}), String(props.title ?? "Collapsible")]
		}), open && (0, import_jsx_runtime.jsx)("div", {
			className: "px-3 pb-3",
			children
		})]
	});
};
const AccordionComponent = (props) => {
	const items = props.items ?? [];
	const isSingle = props.type === "single";
	const [openSet, setOpenSet] = useState(/* @__PURE__ */ new Set());
	const toggle = (idx) => {
		setOpenSet((prev) => {
			const next = isSingle ? /* @__PURE__ */ new Set() : new Set(prev);
			if (prev.has(idx)) next.delete(idx);
			else next.add(idx);
			return next;
		});
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: "border border-border divide-y divide-border",
		children: items.map((item, i) => (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsxs)(Button, {
			type: "button",
			variant: "ghost",
			className: "w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-[var(--bg-hover)] rounded-none justify-start h-auto",
			onClick: () => toggle(i),
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "text-2xs transition-transform",
				style: { transform: openSet.has(i) ? "rotate(90deg)" : "none" },
				children: "▶"
			}), item.title]
		}), openSet.has(i) && (0, import_jsx_runtime.jsx)("div", {
			className: "px-3 pb-3 text-xs",
			children: item.content
		})] }, `${item.title}:${item.content}`))
	});
};
const DialogComponent = (props, children, ctx) => {
	const openPath = props.openPath;
	if (!(openPath ? !!getByPath(ctx.state, openPath) : false)) return null;
	const close = () => {
		if (openPath) ctx.setState(openPath, false);
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50",
		onClick: (e) => {
			if (e.target === e.currentTarget) close();
		},
		onKeyDown: (e) => {
			if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				close();
			}
		},
		role: "dialog",
		"aria-modal": "true",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "w-full max-w-md border border-border bg-card p-5 shadow-lg",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between mb-3",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [props.title ? (0, import_jsx_runtime.jsx)("div", {
					className: "font-bold text-sm",
					children: String(props.title)
				}) : null, props.description ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-xs text-muted mt-0.5",
					children: String(props.description)
				}) : null] }), (0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "ghost",
					size: "icon",
					className: "text-muted hover:text-txt text-lg leading-none px-1 h-auto w-auto",
					onClick: close,
					children: "×"
				})]
			}), children]
		})
	});
};
const DrawerComponent = (props, children, ctx) => {
	const openPath = props.openPath;
	if (!(openPath ? !!getByPath(ctx.state, openPath) : false)) return null;
	const close = () => {
		if (openPath) ctx.setState(openPath, false);
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: "fixed inset-0 z-50 flex items-end bg-black/50",
		onClick: (e) => {
			if (e.target === e.currentTarget) close();
		},
		onKeyDown: (e) => {
			if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				close();
			}
		},
		role: "dialog",
		"aria-modal": "true",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "w-full max-h-[80vh] bg-card p-5 shadow-lg overflow-y-auto animate-[slide-up_200ms_ease]",
			children: [
				(0, import_jsx_runtime.jsx)("div", { className: "w-10 h-1 bg-border mx-auto mb-3 rounded-full" }),
				props.title ? (0, import_jsx_runtime.jsx)("div", {
					className: "font-bold text-sm",
					children: String(props.title)
				}) : null,
				props.description ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-xs text-muted mt-0.5 mb-3",
					children: String(props.description)
				}) : null,
				children
			]
		})
	});
};
const COMPONENTS = {
	Stack: StackComponent,
	Grid: GridComponent,
	Card: CardComponent,
	Separator: SeparatorComponent,
	Heading: HeadingComponent,
	Text: TextComponent,
	Input: InputComponent,
	Textarea: TextareaComponent,
	Select: SelectComponent,
	Checkbox: CheckboxComponent,
	Radio: RadioComponent,
	Switch: SwitchComponent,
	Slider: SliderComponent,
	Toggle: ToggleComponent,
	ToggleGroup: ToggleGroupComponent,
	ButtonGroup: ButtonGroupComponent,
	Table: TableComponent,
	Carousel: CarouselComponent,
	Badge: BadgeComponent,
	Avatar: AvatarComponent,
	Image: ImageComponent,
	Alert: AlertComponent,
	Progress: ProgressComponent,
	Rating: RatingComponent,
	Skeleton: SkeletonComponent,
	Spinner: SpinnerComponent,
	Button: ButtonComponent,
	Link: LinkComponent,
	DropdownMenu: DropdownMenuComponent,
	Tabs: TabsComponent,
	Pagination: PaginationComponent,
	Metric: MetricComponent,
	BarGraph: BarGraphComponent,
	LineGraph: LineGraphComponent,
	Tooltip: TooltipComponent,
	Popover: PopoverComponent,
	Collapsible: CollapsibleComponent,
	Accordion: AccordionComponent,
	Dialog: DialogComponent,
	Drawer: DrawerComponent
};
function ElementRenderer({ elementId }) {
	const { t } = useApp();
	const ctx = useUiCtx();
	const el = ctx.spec.elements[elementId];
	if (!el) return null;
	if (el.visible && !evaluateUiVisibility(el.visible, ctx.state, ctx.auth)) return null;
	const component = COMPONENTS[el.type];
	if (!component) return (0, import_jsx_runtime.jsxs)("div", {
		className: "text-2xs text-destructive border border-dashed border-destructive p-2",
		children: [
			t("ui-renderer.UnknownComponent"),
			" ",
			el.type
		]
	});
	const resolvedProps = resolveProps(el.props, ctx);
	if (el.repeat) {
		const listData = getByPath(ctx.state, el.repeat.path);
		if (!Array.isArray(listData)) return null;
		return (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: listData.map((item) => {
			const itemCtx = {
				...ctx,
				repeatItem: item
			};
			const childNodes = el.children.map((childId) => (0, import_jsx_runtime.jsx)(UiContext.Provider, {
				value: itemCtx,
				children: (0, import_jsx_runtime.jsx)(ElementRenderer, { elementId: childId })
			}, childId));
			const repeatKey = el.repeat?.key;
			const itemKey = String(repeatKey != null ? item[repeatKey] : Math.random());
			return (0, import_jsx_runtime.jsx)(React.Fragment, { children: component(resolvedProps, childNodes, itemCtx, el) }, itemKey);
		}) });
	}
	return (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: component(resolvedProps, el.children.map((childId) => (0, import_jsx_runtime.jsx)(ElementRenderer, { elementId: childId }, childId)), ctx, el) });
}
function UiRenderer({ spec, onAction, loading, auth, validators }) {
	const [state, setStateRaw] = useState(() => ({ ...spec.state }));
	const [fieldErrors, setFieldErrors] = useState({});
	const setState = useCallback((path, value) => {
		setStateRaw((prev) => {
			const next = { ...prev };
			setByPath(next, path, value);
			return next;
		});
	}, []);
	const validateField = useCallback((statePath) => {
		for (const el of Object.values(spec.elements)) if (el.props.statePath === statePath && el.validation) {
			const value = getByPath(state, statePath);
			const errors = runValidation(el.validation.checks, value, validators);
			setFieldErrors((prev) => ({
				...prev,
				[statePath]: errors
			}));
			return;
		}
	}, [
		spec.elements,
		state,
		validators
	]);
	const ctx = useMemo(() => ({
		spec,
		state,
		setState,
		onAction,
		auth,
		loading,
		validators,
		fieldErrors,
		validateField
	}), [
		spec,
		state,
		setState,
		onAction,
		auth,
		loading,
		validators,
		fieldErrors,
		validateField
	]);
	if (loading && Object.keys(spec.elements).length === 0) return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3 animate-pulse",
		children: [
			(0, import_jsx_runtime.jsx)("div", { className: "h-4 bg-[var(--bg-hover)] w-3/4" }),
			(0, import_jsx_runtime.jsx)("div", { className: "h-3 bg-[var(--bg-hover)] w-1/2" }),
			(0, import_jsx_runtime.jsx)("div", { className: "h-3 bg-[var(--bg-hover)] w-5/6" })
		]
	});
	return (0, import_jsx_runtime.jsx)(UiContext.Provider, {
		value: ctx,
		children: (0, import_jsx_runtime.jsx)(ElementRenderer, { elementId: spec.root })
	});
}
/** Get the full list of supported component types. */
function getSupportedComponents() {
	return Object.keys(COMPONENTS);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/message-choice-parser.js
/**
* Parser for `[CHOICE:<scope>(?: id=<id>)?]\n...lines...\n[/CHOICE]` blocks
* emitted by agent actions. Lives in its own module so unit tests can
* exercise the regex/option extraction without pulling the entire
* `MessageContent` React graph (which transitively imports the runtime).
*/
const CHOICE_RE = /\[CHOICE:([\w-]+)(?:\s+id=(\S+))?\]\n([\s\S]*?)\n\[\/CHOICE\]/g;
function generateChoiceId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `choice-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
function parseChoiceBody(body) {
	const options = [];
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const value = line.slice(0, eq).trim();
		const label = line.slice(eq + 1).trim();
		if (!value || !label) continue;
		options.push({
			value,
			label
		});
	}
	return options;
}
/** Find every CHOICE block in `text` and return their character regions. */
function findChoiceRegions(text) {
	const results = [];
	CHOICE_RE.lastIndex = 0;
	let m = CHOICE_RE.exec(text);
	while (m !== null) {
		const scope = m[1];
		const id = m[2] && m[2].length > 0 ? m[2] : generateChoiceId();
		const options = parseChoiceBody(m[3]);
		if (options.length > 0) results.push({
			start: m.index,
			end: m.index + m[0].length,
			id,
			scope,
			options
		});
		m = CHOICE_RE.exec(text);
	}
	return results;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/ChoiceWidget.js
/**
* ChoiceWidget — inline button row for `[CHOICE:...]` blocks emitted by
* agent actions (currently the unified APP and PLUGIN actions when they
* need the user to disambiguate intent).
*
* The widget is purely presentational: it surfaces a list of options as
* buttons and reports the selected `value` back to the caller via
* `onChoose`. After the first selection the entire row locks so the
* agent only ever sees one decision per prompt.
*/
function isCancelLike(value, label) {
	const v = value.toLowerCase();
	const l = label.toLowerCase();
	return v === "cancel" || v === "no" || v === "none" || l === "cancel";
}
function ChoiceWidget({ id, scope, options, onChoose }) {
	const [selected, setSelected] = useState(null);
	const handleChoose = useCallback((option) => {
		if (selected) return;
		setSelected(option);
		onChoose(option.value);
	}, [onChoose, selected]);
	if (options.length === 0) return null;
	return (0, import_jsx_runtime.jsxs)("fieldset", {
		className: "my-2 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0",
		"aria-label": `Choose ${scope}`,
		"data-choice-id": id,
		"data-choice-scope": scope,
		children: [options.map((option) => {
			const cancel = isCancelLike(option.value, option.label);
			const isSelected = selected?.value === option.value;
			return (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: cancel ? "ghost" : "outline",
				size: "sm",
				disabled: selected !== null,
				"aria-label": option.label,
				"aria-pressed": isSelected,
				"data-testid": `choice-${option.value}`,
				className: cancel ? "h-7 px-3 text-xs text-muted hover:text-txt disabled:opacity-40" : "h-7 px-3 text-xs disabled:opacity-40",
				onClick: () => handleChoose(option),
				children: isSelected ? (0, import_jsx_runtime.jsxs)("span", {
					className: "inline-flex items-center gap-1",
					children: [(0, import_jsx_runtime.jsx)(Check, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), (0, import_jsx_runtime.jsx)("span", { children: option.label })]
				}) : option.label
			}, option.value);
		}), selected ? (0, import_jsx_runtime.jsxs)("span", {
			className: "text-2xs text-muted",
			role: "status",
			children: ["Selected: ", selected.label]
		}) : null]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/MessageContent.js
/** Reject prototype-pollution keys that should never be traversed or rendered. */
const BLOCKED_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const SAFE_PLUGIN_ID_RE = /^[\w-]+$/;
function createSafeRecord() {
	return Object.create(null);
}
function sanitizePatchValue(value) {
	if (Array.isArray(value)) return value.map((item) => sanitizePatchValue(item));
	if (!value || typeof value !== "object") return value;
	const safe = createSafeRecord();
	for (const [key, nestedValue] of Object.entries(value)) {
		if (BLOCKED_IDS.has(key)) continue;
		safe[key] = sanitizePatchValue(nestedValue);
	}
	return safe;
}
function isSafeNormalizedPluginId(id) {
	return !BLOCKED_IDS.has(id) && SAFE_PLUGIN_ID_RE.test(id);
}
const CONFIG_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;
/**
* Strip elizaOS action XML blocks (`<actions>...</actions>` and
* `<params>...</params>`) from displayed text. These are framework
* metadata, not user-facing content.
*/
const ACTION_XML_RE = /\s*<actions>[\s\S]*?(?:<\/actions>|$)\s*|\s*<params>[\s\S]*?(?:<\/params>|$)\s*/g;
const HIDDEN_XML_BLOCK_RE = /<(think|analysis|reasoning|scratchpad|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
function extractXmlTag(raw, tag, opts) {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = raw.indexOf(open);
	if (start < 0) return null;
	const contentStart = start + open.length;
	const end = raw.indexOf(close, contentStart);
	if (end < 0) return opts?.allowPartial ? raw.slice(contentStart) : null;
	return raw.slice(contentStart, end);
}
/**
* Strip partial/incomplete XML tags at the end of a streaming text chunk.
* During streaming, the buffer may end mid-tag (e.g. `"Hello<thi"`,
* `"Hello</respon"`, or just `"Hello<"`).  These fragments are not
* user-facing content and must be hidden from both the display and voice
* pipelines.
*/
const TRAILING_PARTIAL_TAG_RE = /<\/?[a-zA-Z][^>]*$|<\/?$/s;
function normalizeDisplayText(text) {
	const MAX_DISPLAY_LEN = 2e5;
	let normalized = text.length > MAX_DISPLAY_LEN ? text.slice(0, MAX_DISPLAY_LEN) : text;
	normalized = normalized.replace(ACTION_XML_RE, "");
	normalized = normalized.replace(HIDDEN_XML_BLOCK_RE, " ");
	if (normalized.includes("<response>")) {
		const wrappedText = extractXmlTag(normalized, "text", { allowPartial: true });
		if (wrappedText !== null) normalized = wrappedText;
		else return "";
	}
	normalized = normalized.replace(/<\/?(response|text|thought)\b[^>]*>/gi, "");
	normalized = normalized.replace(TRAILING_PARTIAL_TAG_RE, "");
	normalized = stripAssistantStageDirections(normalized);
	return normalized.trim();
}
function tryParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
function isUiSpec(obj) {
	if (!obj || typeof obj !== "object") return false;
	const c = obj;
	return typeof c.root === "string" && typeof c.elements === "object" && c.elements !== null;
}
/**
* Quick pre-check: does this line look like a JSON patch object?
* Handles both compact `{"op":` and spaced `{ "op":` formats.
*/
function looksLikePatch(trimmed) {
	if (!trimmed.startsWith("{")) return false;
	return trimmed.includes("\"op\"") && trimmed.includes("\"path\"");
}
/** Try to parse a single line as an RFC 6902 JSON Patch operation. */
function tryParsePatch(line) {
	const t = line.trim();
	if (!looksLikePatch(t)) return null;
	try {
		const obj = JSON.parse(t);
		if (typeof obj.op === "string" && typeof obj.path === "string") return obj;
		return null;
	} catch {
		return null;
	}
}
/**
* Apply a list of RFC 6902 patches to build a UiSpec.
*
* Only handles the paths the catalog emits:
*   /root              → spec.root
*   /elements/<id>     → spec.elements[id]
*   /state/<key>       → spec.state[key]
*   /state             → spec.state (whole object)
*/
function compilePatches(patches) {
	const spec = {
		elements: {},
		state: createSafeRecord()
	};
	for (const patch of patches) {
		if (patch.op !== "add" && patch.op !== "replace") continue;
		const { path, value } = patch;
		const parts = path.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (parts[0] === "root" && parts.length === 1) spec.root = value;
		else if (parts[0] === "elements" && parts.length === 2) spec.elements[parts[1]] = value;
		else if (parts[0] === "state" && parts.length === 1) {
			const nextState = sanitizePatchValue(value);
			spec.state = nextState && typeof nextState === "object" && !Array.isArray(nextState) ? nextState : createSafeRecord();
		} else if (parts[0] === "state" && parts.length >= 2) {
			let cursor = spec.state;
			let blockedPath = false;
			for (let i = 1; i < parts.length - 1; i++) {
				const k = parts[i];
				if (BLOCKED_IDS.has(k)) {
					blockedPath = true;
					break;
				}
				if (!cursor[k] || typeof cursor[k] !== "object" || Array.isArray(cursor[k])) cursor[k] = createSafeRecord();
				cursor = cursor[k];
			}
			if (blockedPath) continue;
			const leaf = parts[parts.length - 1];
			if (BLOCKED_IDS.has(leaf)) continue;
			cursor[leaf] = sanitizePatchValue(value);
		}
	}
	return isUiSpec(spec) ? spec : null;
}
/**
* Scan `text` for blocks of consecutive JSONL patch lines and return
* their character regions plus the compiled UiSpec.
*
* A patch block is a run of lines where each non-empty line parses as a
* valid PatchOp. A single empty line between patch lines is allowed.
*/
function findPatchRegions(text) {
	const results = [];
	const lines = text.split("\n");
	let blockStart = -1;
	let blockEnd = 0;
	let patches = [];
	let rawLines = [];
	let pos = 0;
	const flush = () => {
		if (patches.length >= 1) {
			const spec = compilePatches(patches);
			if (spec) results.push({
				start: blockStart,
				end: blockEnd,
				spec,
				raw: rawLines.join("\n")
			});
		}
		blockStart = -1;
		patches = [];
		rawLines = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
		const trimmed = line.trim();
		if (looksLikePatch(trimmed)) {
			const patch = tryParsePatch(trimmed);
			if (patch) {
				if (blockStart === -1) blockStart = pos;
				patches.push(patch);
				rawLines.push(line);
				blockEnd = pos + lineLen;
				pos += lineLen;
				continue;
			}
		}
		if (trimmed.length === 0 && blockStart !== -1) {
			const nextPatch = lines.slice(i + 1).find((l) => l.trim().length > 0);
			if (nextPatch && tryParsePatch(nextPatch) !== null) {
				pos += lineLen;
				continue;
			}
		}
		if (blockStart !== -1) flush();
		pos += lineLen;
	}
	if (blockStart !== -1) flush();
	return results;
}
/**
* Parse message text for [CONFIG:id] markers, [CHOICE:...] blocks,
* fenced UiSpec JSON, and inline JSONL patch blocks (Chat Mode).
* Returns an array of segments for rendering.
*/
function parseSegments(text) {
	const cleaned = normalizeDisplayText(text);
	if (!cleaned) return [{
		kind: "text",
		text: ""
	}];
	const regions = [];
	CONFIG_RE.lastIndex = 0;
	let m = CONFIG_RE.exec(cleaned);
	while (m !== null) {
		regions.push({
			start: m.index,
			end: m.index + m[0].length,
			segment: {
				kind: "config",
				pluginId: m[1]
			}
		});
		m = CONFIG_RE.exec(cleaned);
	}
	for (const choice of findChoiceRegions(cleaned)) regions.push({
		start: choice.start,
		end: choice.end,
		segment: {
			kind: "choice",
			id: choice.id,
			scope: choice.scope,
			options: choice.options
		}
	});
	FENCED_JSON_RE.lastIndex = 0;
	m = FENCED_JSON_RE.exec(cleaned);
	while (m !== null) {
		const json = m[1].trim();
		const parsed = tryParse(json);
		if (parsed && isUiSpec(parsed)) regions.push({
			start: m.index,
			end: m.index + m[0].length,
			segment: {
				kind: "ui-spec",
				spec: parsed,
				raw: json
			}
		});
		m = FENCED_JSON_RE.exec(cleaned);
	}
	for (const patch of findPatchRegions(cleaned)) if (!regions.some((r) => patch.start < r.end && patch.end > r.start)) regions.push({
		start: patch.start,
		end: patch.end,
		segment: {
			kind: "ui-spec",
			spec: patch.spec,
			raw: patch.raw
		}
	});
	if (regions.length === 0) return [{
		kind: "text",
		text: cleaned
	}];
	regions.sort((a, b) => a.start - b.start);
	const segments = [];
	let cursor = 0;
	for (const r of regions) {
		if (r.start < cursor) continue;
		if (r.start > cursor) {
			const t = cleaned.slice(cursor, r.start);
			if (t.trim()) segments.push({
				kind: "text",
				text: t
			});
		}
		segments.push(r.segment);
		cursor = r.end;
	}
	if (cursor < cleaned.length) {
		const t = cleaned.slice(cursor);
		if (t.trim()) segments.push({
			kind: "text",
			text: t
		});
	}
	return segments;
}
/** Normalize plugin ID: strip @scope/plugin- prefix so both "discord" and "@elizaos/plugin-discord" resolve. */
function normalizePluginId(id) {
	return id.replace(/^@[^/]+\/plugin-/, "");
}
function buildInlinePluginConfigModel(plugin, values) {
	const pluginParams = plugin?.parameters ?? [];
	if (!(pluginParams.length > 0) || !plugin?.id) return {
		hasConfigurableParams: false,
		hints: {},
		mergedValues: values,
		schema: null,
		setKeys: /* @__PURE__ */ new Set()
	};
	const auto = paramsToSchema(pluginParams, plugin.id);
	if (plugin.configUiHints) for (const [key, serverHint] of Object.entries(plugin.configUiHints)) auto.hints[key] = {
		...auto.hints[key],
		...serverHint
	};
	const initialValues = {};
	const setKeys = /* @__PURE__ */ new Set();
	for (const param of pluginParams) {
		if (param.isSet) setKeys.add(param.key);
		if (param.isSet && !param.sensitive && param.currentValue != null) initialValues[param.key] = param.currentValue;
	}
	for (const [key, value] of Object.entries(values)) if (value != null && value !== "") setKeys.add(key);
	return {
		hasConfigurableParams: true,
		hints: auto.hints,
		mergedValues: {
			...initialValues,
			...values
		},
		schema: auto.schema,
		setKeys
	};
}
function InlinePluginConfig({ pluginId: rawPluginId }) {
	const pluginId = normalizePluginId(rawPluginId);
	const [plugin, setPlugin] = useState(null);
	const [loading, setLoading] = useState(true);
	const [values, setValues] = useState({});
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [enabling, setEnabling] = useState(false);
	const [error, setError] = useState(null);
	const [dismissed, setDismissed] = useState(false);
	const mountedRef = useRef(true);
	const refreshTimerRef = useRef(null);
	const { setActionNotice, loadPlugins, t } = useApp();
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
		};
	}, []);
	const fetchPlugin = useCallback(async () => {
		try {
			const { plugins } = await client.getPlugins();
			if (!mountedRef.current) return;
			setPlugin(plugins.find((p) => p.id === pluginId) ?? null);
		} catch {
			if (mountedRef.current) setError(t("messagecontent.LoadPluginInfoFailed", { defaultValue: "Couldn't load plugin info." }));
		} finally {
			if (mountedRef.current) setLoading(false);
		}
	}, [pluginId, t]);
	useEffect(() => {
		fetchPlugin();
	}, [fetchPlugin]);
	const { hasConfigurableParams, hints, mergedValues, schema, setKeys } = useMemo(() => buildInlinePluginConfigModel(plugin, values), [plugin, values]);
	const handleChange = useCallback((key, value) => {
		setValues((prev) => ({
			...prev,
			[key]: value
		}));
		setSaved(false);
		setError(null);
	}, []);
	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			const patch = {};
			for (const [k, v] of Object.entries(values)) if (v != null && v !== "") patch[k] = String(v);
			await client.updatePlugin(pluginId, { config: patch });
			if (mountedRef.current) setSaved(true);
			await fetchPlugin();
		} catch (e) {
			if (mountedRef.current) setError(e instanceof Error ? e.message : t("messagecontent.SaveFailed", { defaultValue: "Couldn't save changes." }));
		} finally {
			if (mountedRef.current) setSaving(false);
		}
	}, [
		pluginId,
		values,
		fetchPlugin,
		t
	]);
	const handleToggle = useCallback(async (enable) => {
		setEnabling(true);
		setError(null);
		try {
			if (enable) {
				const patch = {};
				for (const [k, v] of Object.entries(values)) if (v != null && v !== "") patch[k] = String(v);
				if (Object.keys(patch).length > 0) await client.updatePlugin(pluginId, { config: patch });
			}
			await client.updatePlugin(pluginId, { enabled: enable });
			await loadPlugins();
			if (enable && mountedRef.current) {
				const tabLabel = plugin?.category === "feature" ? t("messagecontent.FeaturesTabLabel", { defaultValue: "Plugins > Features" }) : plugin?.category === "connector" ? t("messagecontent.ConnectorsTabLabel", { defaultValue: "Plugins > Connectors" }) : t("messagecontent.SystemTabLabel", { defaultValue: "Plugins > System" });
				setActionNotice(t("messagecontent.PluginEnabledNotice", {
					defaultValue: "{{name}} is on. Find it in {{tabLabel}}.",
					name: plugin?.name ?? pluginId,
					tabLabel
				}), "success", 4e3);
				setDismissed(true);
			}
			refreshTimerRef.current = setTimeout(() => void fetchPlugin(), 3e3);
		} catch (e) {
			if (mountedRef.current) setError(e instanceof Error ? e.message : enable ? t("messagecontent.EnablePluginFailed", { defaultValue: "Couldn't enable this plugin." }) : t("messagecontent.DisablePluginFailed", { defaultValue: "Couldn't disable this plugin." }));
		} finally {
			if (mountedRef.current) setEnabling(false);
		}
	}, [
		pluginId,
		plugin,
		values,
		fetchPlugin,
		loadPlugins,
		setActionNotice,
		t
	]);
	if (dismissed) return (0, import_jsx_runtime.jsx)("div", {
		className: "my-2 px-3 py-2 border border-ok/30 bg-ok/5 text-xs text-ok",
		children: t("messagecontent.PluginEnabledInlineNotice", {
			defaultValue: "{{name}} is enabled.",
			name: plugin?.name ?? pluginId
		})
	});
	if (loading) return (0, import_jsx_runtime.jsx)("div", {
		className: "my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic",
		children: t("messagecontent.LoadingConfiguration", {
			defaultValue: "Loading {{pluginId}} configuration...",
			pluginId
		})
	});
	if (!plugin) return (0, import_jsx_runtime.jsx)("div", {
		className: "my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic",
		children: t("messagecontent.PluginNotFound", {
			defaultValue: "Plugin \"{{pluginId}}\" not found.",
			pluginId
		})
	});
	const isEnabled = plugin.enabled;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "my-2 border border-border bg-card overflow-hidden",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between px-3 py-2 bg-bg-hover",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2 text-xs font-bold text-txt",
					children: [plugin.icon ? (0, import_jsx_runtime.jsx)("span", {
						className: "text-sm",
						children: plugin.icon
					}) : (0, import_jsx_runtime.jsx)("span", {
						className: "text-sm opacity-60",
						children: "⚙️"
					}), (0, import_jsx_runtime.jsx)("span", { children: t("messagecontent.PluginConfigurationTitle", {
						defaultValue: "{{name}} Configuration",
						name: plugin.name
					}) })]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [plugin.configured && (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs text-ok font-medium",
						children: t("config-field.Configured")
					}), (0, import_jsx_runtime.jsx)("span", {
						className: `text-2xs font-medium ${isEnabled ? "text-ok" : "text-muted"}`,
						children: isEnabled ? t("common.active", { defaultValue: "Active" }) : t("common.inactive", { defaultValue: "Inactive" })
					})]
				})]
			}),
			schema && hasConfigurableParams ? (0, import_jsx_runtime.jsx)("div", {
				className: "p-3",
				children: (0, import_jsx_runtime.jsx)(ConfigRenderer, {
					schema,
					hints,
					values: mergedValues,
					setKeys,
					registry: defaultRegistry,
					pluginId: plugin.id,
					onChange: handleChange
				})
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 py-2 text-xs text-muted italic",
				children: t("messagecontent.NoConfigurablePara")
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-3 py-2 flex-wrap",
				children: [
					schema && hasConfigurableParams && (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "px-4 py-1.5 h-7 text-xs shadow-sm bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40",
						onClick: handleSave,
						disabled: saving || enabling || Object.keys(values).length === 0,
						children: saving ? t("common.saving", { defaultValue: "Saving..." }) : t("common.save")
					}),
					!isEnabled ? (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "px-4 py-1.5 h-7 text-xs border-ok/50 text-ok bg-ok/5 hover:bg-ok/10 hover:text-ok disabled:opacity-40",
						onClick: () => void handleToggle(true),
						disabled: enabling || saving,
						children: enabling ? t("messagecontent.Enabling", { defaultValue: "Turning on..." }) : t("messagecontent.EnablePlugin", { defaultValue: "Enable plugin" })
					}) : (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "px-4 py-1.5 h-7 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-40",
						onClick: () => void handleToggle(false),
						disabled: enabling || saving,
						children: enabling ? t("messagecontent.Disabling", { defaultValue: "Turning off..." }) : t("common.disable", { defaultValue: "Disable" })
					}),
					saved && (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs text-ok",
						children: t("common.saved")
					}),
					error && (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs text-danger",
						children: error
					})
				]
			})
		]
	});
}
function UiSpecBlock({ spec, raw }) {
	const { t } = useApp();
	const { sendActionMessage } = useApp();
	const [showRaw, setShowRaw] = useState(false);
	const handleAction = useCallback((action, params) => {
		if (action === "plugin:save" && params?.pluginId) {
			const pluginId = String(params.pluginId);
			const config = {};
			if (params) {
				for (const [key, value] of Object.entries(params)) if (key.startsWith("config.") && typeof value === "string" && value.trim()) config[key.slice(7)] = value.trim();
			}
			client.updatePlugin(pluginId, { config }).then(() => sendActionMessage(`[Plugin ${pluginId} configuration saved successfully]`)).catch((err) => sendActionMessage(`[Failed to save plugin config: ${err instanceof Error ? err.message : "unknown error"}]`));
			return;
		}
		if (action === "plugin:enable" && params?.pluginId) {
			client.updatePlugin(String(params.pluginId), { enabled: true }).then(() => sendActionMessage(`[Plugin ${params.pluginId} enabled. Restart required.]`)).catch(() => sendActionMessage(`[Failed to enable plugin]`));
			return;
		}
		if (action === "plugin:test" && params?.pluginId) {
			sendActionMessage(`[Testing ${params.pluginId} connection...]`);
			return;
		}
		if (action === "plugin:configure" && params?.pluginId) {
			sendActionMessage(`Please show me the configuration form for the ${params.pluginId} plugin`);
			return;
		}
		sendActionMessage(`[action:${action}]${params ? ` ${JSON.stringify(params)}` : ""}`);
	}, [sendActionMessage]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "my-2 border border-border overflow-hidden",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between px-3 py-1.5 bg-bg-hover",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "text-2xs font-semibold text-muted uppercase tracking-wider",
					children: t("messagecontent.InteractiveUI")
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "link",
					size: "sm",
					className: "h-auto p-0 text-2xs text-txt hover:underline decoration-accent/50 underline-offset-2",
					onClick: () => setShowRaw((v) => !v),
					children: showRaw ? t("messagecontent.HideJson", { defaultValue: "Hide JSON" }) : t("messagecontent.ViewJson", { defaultValue: "View JSON" })
				})]
			}),
			showRaw && (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 py-2 bg-card overflow-x-auto",
				children: (0, import_jsx_runtime.jsx)("pre", {
					className: "text-2xs text-muted font-mono whitespace-pre-wrap break-words m-0",
					children: raw
				})
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "p-3",
				children: (0, import_jsx_runtime.jsx)(UiRenderer, {
					spec,
					onAction: handleAction
				})
			})
		]
	});
}
function MessageContent({ message }) {
	const { sendActionMessage } = useApp();
	const segments = useMemo(() => {
		try {
			return parseSegments(message.text);
		} catch {
			return [{
				kind: "text",
				text: message.text
			}];
		}
	}, [message.text]);
	const handleChoice = useCallback((value) => {
		sendActionMessage(value);
	}, [sendActionMessage]);
	if (segments.length === 1 && segments[0].kind === "text") return (0, import_jsx_runtime.jsx)("div", {
		className: "whitespace-pre-wrap",
		children: segments[0].text
	});
	return (0, import_jsx_runtime.jsx)("div", { children: (() => {
		const keyCounts = /* @__PURE__ */ new Map();
		const nextKey = (base) => {
			const nextCount = (keyCounts.get(base) ?? 0) + 1;
			keyCounts.set(base, nextCount);
			return `${base}:${nextCount}`;
		};
		return segments.map((seg) => {
			const segmentKey = nextKey(seg.kind === "text" ? `text:${seg.text.slice(0, 80)}` : seg.kind === "config" ? `config:${seg.pluginId}` : seg.kind === "choice" ? `choice:${seg.id}` : `ui:${seg.raw.slice(0, 80)}`);
			switch (seg.kind) {
				case "text": return (0, import_jsx_runtime.jsx)("div", {
					className: "whitespace-pre-wrap",
					children: seg.text
				}, segmentKey);
				case "config":
					if (!isSafeNormalizedPluginId(normalizePluginId(seg.pluginId))) return null;
					return (0, import_jsx_runtime.jsx)(InlinePluginConfig, { pluginId: seg.pluginId }, segmentKey);
				case "ui-spec": return (0, import_jsx_runtime.jsx)(UiSpecBlock, {
					spec: seg.spec,
					raw: seg.raw
				}, segmentKey);
				case "choice": return (0, import_jsx_runtime.jsx)(ChoiceWidget, {
					id: seg.id,
					scope: seg.scope,
					options: seg.options,
					onChoose: handleChoice
				}, segmentKey);
				default: return null;
			}
		});
	})() });
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/chat-view-hooks.js
const COMPANION_VISIBLE_MESSAGE_LIMIT = 2;
const COMPANION_HISTORY_HOLD_MS = 3e4;
const COMPANION_HISTORY_FADE_MS = 5e3;
function nowMs() {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function mapUiLanguageToSpeechLocale(uiLanguage) {
	switch (uiLanguage) {
		case "zh-CN": return "zh-CN";
		case "ko": return "ko-KR";
		case "es": return "es-ES";
		case "pt": return "pt-BR";
		case "vi": return "vi-VN";
		case "tl": return "fil-PH";
		default: return "en-US";
	}
}
function findLatestAssistantMessage(messages) {
	return [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
}
const companionSpeechMemoryByConversation = /* @__PURE__ */ new Map();
function rememberCompanionSpeech(conversationId, messageId, text) {
	if (!conversationId) return;
	companionSpeechMemoryByConversation.set(conversationId, {
		messageId,
		text
	});
	if (companionSpeechMemoryByConversation.size <= 100) return;
	const oldestConversationId = companionSpeechMemoryByConversation.keys().next().value;
	if (oldestConversationId) companionSpeechMemoryByConversation.delete(oldestConversationId);
}
function hasCompanionSpeechBeenPlayed(conversationId, messageId, text) {
	if (!conversationId) return false;
	const remembered = companionSpeechMemoryByConversation.get(conversationId);
	return remembered?.messageId === messageId && remembered.text === text;
}
function __resetCompanionSpeechMemoryForTests() {
	companionSpeechMemoryByConversation.clear();
}
/**
* Chat assistant TTS pipeline — order matters for cloud-backed voice:
* 1. Server exposes Eliza Cloud via `GET /api/cloud/status` (`hasApiKey`, `enabled`, `connected`).
* 2. `AppContext.pollCloudCredits` persists React state and dispatches {@link ELIZA_CLOUD_STATUS_UPDATED_EVENT}.
* 3. This hook stores `detail.cloudVoiceProxyAvailable` in a ref for same-turn
*    `true` before React state commits; `cloudConnected` is `context || ref===true`
*    so an early `false` snapshot cannot block TTS after auth loads. Then reloads
*    `messages.tts` from `getConfig`.
* 4. `useVoiceChat` resolves cloud vs own-key mode and speaks via `/api/tts/cloud`
*    only when cloud inference is actually selected, not merely linked.
*/
function useChatVoiceController(options) {
	const { setTimeout } = useTimeout();
	const { avatarReady: companionSceneAvatarReady } = useCompanionSceneStatus();
	const { agentVoiceMuted, chatFirstTokenReceived, chatInput, chatSending, elizaCloudConnected, elizaCloudVoiceProxyAvailable, elizaCloudHasPersistedKey, conversationMessages, activeConversationId, handleChatEdit, handleChatSend, isComposerLocked, isGameModal, setState, uiLanguage } = options;
	/** After the first `eliza:cloud-status-updated`, mirrors server `cloudVoiceProxyAvailable` (avoids one-frame lag vs context). */
	const [cloudVoiceSnapshot, setCloudVoiceSnapshot] = useState(null);
	const [voiceConfig, setVoiceConfig] = useState(null);
	/** Bumps after each `getConfig` (or inline VOICE_CONFIG event) settles — game-modal auto-speak waits for this so TTS does not run with a stale/null voice profile and get stuck deduped. */
	const [voiceBootstrapTick, setVoiceBootstrapTick] = useState(0);
	const [voiceLatency, setVoiceLatency] = useState(null);
	const pendingVoiceTurnRef = useRef(null);
	const suppressedAssistantSpeechIdRef = useRef(null);
	/** Skips duplicate companion auto-speak when only `voiceBootstrapTick` bumps (config/cloud reload) for the same assistant text. */
	const companionBootstrapAutoSpeakRef = useRef(null);
	const initialCompletedAssistantOnGameModalMountRef = useRef(isGameModal && !chatSending ? (() => {
		const latestAssistant = findLatestAssistantMessage(conversationMessages);
		if (!latestAssistant) return null;
		return {
			messageId: latestAssistant.id,
			text: latestAssistant.text
		};
	})() : null);
	const voiceDraftBaseInputRef = useRef("");
	const prevIsGameModalRef = useRef(isGameModal);
	const gameModalJustActivatedRef = useRef(false);
	const loadVoiceConfig = useCallback(async () => {
		try {
			const resolved = resolveCharacterVoiceConfigFromAppConfig({
				config: await client.getConfig(),
				uiLanguage
			});
			setVoiceConfig(resolved.voiceConfig);
			if (resolved.shouldPersist && resolved.voiceConfig) client.updateConfig({ messages: { tts: resolved.voiceConfig } }).catch(() => {});
		} catch {
			setVoiceConfig(null);
		} finally {
			setVoiceBootstrapTick((t) => t + 1);
		}
	}, [uiLanguage]);
	useEffect(() => {
		loadVoiceConfig();
	}, [loadVoiceConfig]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const handler = (event) => {
			const detail = event.detail;
			if (detail && typeof detail === "object") {
				setVoiceConfig(detail);
				setVoiceBootstrapTick((t) => t + 1);
				return;
			}
			loadVoiceConfig();
		};
		window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
		return () => window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
	}, [loadVoiceConfig]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onCloudStatus = (event) => {
			const detail = event.detail;
			if (detail && typeof detail === "object") ttsDebug("chat:cloud-status-event", {
				cloudVoiceProxyAvailable: detail.cloudVoiceProxyAvailable,
				connected: detail.connected,
				enabled: detail.enabled,
				hasPersistedApiKey: detail.hasPersistedApiKey
			});
			if (detail && typeof detail.cloudVoiceProxyAvailable === "boolean") setCloudVoiceSnapshot(detail.cloudVoiceProxyAvailable);
			loadVoiceConfig();
		};
		window.addEventListener(ELIZA_CLOUD_STATUS_UPDATED_EVENT, onCloudStatus);
		return () => window.removeEventListener(ELIZA_CLOUD_STATUS_UPDATED_EVENT, onCloudStatus);
	}, [loadVoiceConfig]);
	const composeVoiceDraft = useCallback((transcript) => {
		const base = voiceDraftBaseInputRef.current.trim();
		const spoken = transcript.trim();
		if (base && spoken) return `${base} ${spoken}`;
		return base || spoken;
	}, []);
	const handleVoiceTranscript = useCallback((text) => {
		if (isComposerLocked) return;
		const composedText = composeVoiceDraft(text);
		if (!composedText) return;
		const speechEndedAtMs = nowMs();
		pendingVoiceTurnRef.current = {
			expiresAtMs: speechEndedAtMs + 15e3,
			speechEndedAtMs
		};
		setVoiceLatency(null);
		setState("chatInput", composedText);
		setTimeout(() => void handleChatSend("VOICE_DM"), 50);
	}, [
		composeVoiceDraft,
		handleChatSend,
		isComposerLocked,
		setState,
		setTimeout
	]);
	const handleVoiceTranscriptPreview = useCallback((text) => {
		if (isComposerLocked) return;
		setState("chatInput", composeVoiceDraft(text));
	}, [
		composeVoiceDraft,
		isComposerLocked,
		setState
	]);
	const handleVoicePlaybackStart = useCallback((event) => {
		ttsDebug("chat:playback-start", {
			provider: event.provider,
			segment: event.segment,
			cached: event.cached
		});
		const pending = pendingVoiceTurnRef.current;
		if (!pending) return;
		if (event.startedAtMs > pending.expiresAtMs) {
			pendingVoiceTurnRef.current = null;
			return;
		}
		if (pending.voiceStartedAtMs != null) return;
		pending.voiceStartedAtMs = event.startedAtMs;
		pending.firstSegmentCached = event.cached;
		setVoiceLatency((prev) => ({
			firstSegmentCached: event.cached,
			speechEndToFirstTokenMs: prev?.speechEndToFirstTokenMs ?? null,
			speechEndToVoiceStartMs: Math.max(0, Math.round(event.startedAtMs - pending.speechEndedAtMs))
		}));
	}, []);
	const cloudVoiceAvailable = useMemo(() => {
		return elizaCloudVoiceProxyAvailable || cloudVoiceSnapshot === true;
	}, [cloudVoiceSnapshot, elizaCloudVoiceProxyAvailable]);
	useEffect(() => {
		ttsDebug("chat:cloud-voice-available", {
			cloudVoiceAvailable,
			elizaCloudConnected,
			elizaCloudVoiceProxyAvailable,
			elizaCloudHasPersistedKey,
			snapshotValue: cloudVoiceSnapshot
		});
	}, [
		cloudVoiceAvailable,
		cloudVoiceSnapshot,
		elizaCloudConnected,
		elizaCloudVoiceProxyAvailable,
		elizaCloudHasPersistedKey
	]);
	const voice = useVoiceChat({
		cloudConnected: cloudVoiceAvailable,
		interruptOnSpeech: isGameModal,
		lang: mapUiLanguageToSpeechLocale(uiLanguage),
		onPlaybackStart: handleVoicePlaybackStart,
		onTranscript: handleVoiceTranscript,
		onTranscriptPreview: handleVoiceTranscriptPreview,
		voiceConfig
	});
	const { queueAssistantSpeech, speak, startListening, stopListening, stopSpeaking, voiceUnlockedGeneration } = voice;
	const prevVoiceUnlockGenRef = useRef(null);
	useLayoutEffect(() => {
		if (prevVoiceUnlockGenRef.current === null) {
			prevVoiceUnlockGenRef.current = voiceUnlockedGeneration;
			return;
		}
		if (prevVoiceUnlockGenRef.current === voiceUnlockedGeneration) return;
		prevVoiceUnlockGenRef.current = voiceUnlockedGeneration;
		stopSpeaking();
	}, [voiceUnlockedGeneration, stopSpeaking]);
	const beginVoiceCapture = useCallback((mode = "compose") => {
		if (isComposerLocked || voice.isListening) return;
		suppressedAssistantSpeechIdRef.current = findLatestAssistantMessage(conversationMessages)?.id ?? null;
		voiceDraftBaseInputRef.current = chatInput;
		stopSpeaking();
		startListening(mode);
	}, [
		chatInput,
		conversationMessages,
		isComposerLocked,
		startListening,
		stopSpeaking,
		voice.isListening
	]);
	const endVoiceCapture = useCallback((captureOptions) => {
		if (!voice.isListening) return;
		stopListening(captureOptions);
	}, [stopListening, voice.isListening]);
	const handleSpeakMessage = useCallback((messageId, text) => {
		if (!text.trim()) return;
		suppressedAssistantSpeechIdRef.current = messageId;
		rememberCompanionSpeech(activeConversationId, messageId, text);
		speak(text);
	}, [activeConversationId, speak]);
	const handleEditMessage = useCallback(async (messageId, text) => {
		stopSpeaking();
		return handleChatEdit(messageId, text);
	}, [handleChatEdit, stopSpeaking]);
	const hasSetInitialGameModalRef = useRef(false);
	useEffect(() => {
		if (!hasSetInitialGameModalRef.current) {
			hasSetInitialGameModalRef.current = true;
			prevIsGameModalRef.current = isGameModal;
			return;
		}
		if (isGameModal && !prevIsGameModalRef.current) gameModalJustActivatedRef.current = true;
		prevIsGameModalRef.current = isGameModal;
	}, [isGameModal]);
	useEffect(() => {
		if (!isGameModal) companionBootstrapAutoSpeakRef.current = null;
	}, [isGameModal]);
	useEffect(() => {
		if (!isGameModal || agentVoiceMuted || voice.isListening) return;
		if (!companionSceneAvatarReady) return;
		if (voiceBootstrapTick === 0) return;
		if (gameModalJustActivatedRef.current) {
			gameModalJustActivatedRef.current = false;
			return;
		}
		const latestAssistant = findLatestAssistantMessage(conversationMessages);
		if (!latestAssistant) return;
		if (suppressedAssistantSpeechIdRef.current === latestAssistant.id) return;
		const tick = voiceBootstrapTick;
		const messageId = latestAssistant.id;
		const text = latestAssistant.text;
		const ug = voiceUnlockedGeneration;
		const initialCompletedAssistant = initialCompletedAssistantOnGameModalMountRef.current;
		if (initialCompletedAssistant && !chatSending && initialCompletedAssistant.messageId === messageId && initialCompletedAssistant.text === text) {
			initialCompletedAssistantOnGameModalMountRef.current = null;
			companionBootstrapAutoSpeakRef.current = {
				tick,
				messageId,
				text,
				unlockGen: ug
			};
			return;
		}
		if (initialCompletedAssistant) initialCompletedAssistantOnGameModalMountRef.current = null;
		if (hasCompanionSpeechBeenPlayed(activeConversationId, messageId, text)) {
			companionBootstrapAutoSpeakRef.current = {
				tick,
				messageId,
				text,
				unlockGen: ug
			};
			return;
		}
		const prev = companionBootstrapAutoSpeakRef.current;
		if (prev && prev.messageId === messageId && prev.text === text && prev.unlockGen === ug) {
			if (tick > prev.tick) {
				companionBootstrapAutoSpeakRef.current = {
					tick,
					messageId,
					text,
					unlockGen: ug
				};
				return;
			}
			if (tick === prev.tick) return;
		}
		queueAssistantSpeech(messageId, text, !chatSending);
		rememberCompanionSpeech(activeConversationId, messageId, text);
		suppressedAssistantSpeechIdRef.current = null;
		companionBootstrapAutoSpeakRef.current = {
			tick,
			messageId,
			text,
			unlockGen: ug
		};
	}, [
		agentVoiceMuted,
		activeConversationId,
		chatSending,
		companionSceneAvatarReady,
		conversationMessages,
		isGameModal,
		queueAssistantSpeech,
		voice.isListening,
		voiceBootstrapTick,
		voiceUnlockedGeneration
	]);
	useEffect(() => {
		if (!agentVoiceMuted) return;
		stopSpeaking();
	}, [agentVoiceMuted, stopSpeaking]);
	useEffect(() => {
		const pending = pendingVoiceTurnRef.current;
		if (!pending || !chatFirstTokenReceived) return;
		if (nowMs() > pending.expiresAtMs) {
			pendingVoiceTurnRef.current = null;
			return;
		}
		if (pending.firstTokenAtMs != null) return;
		const firstTokenAtMs = nowMs();
		pending.firstTokenAtMs = firstTokenAtMs;
		setVoiceLatency((prev) => ({
			firstSegmentCached: prev?.firstSegmentCached ?? null,
			speechEndToFirstTokenMs: Math.max(0, Math.round(firstTokenAtMs - pending.speechEndedAtMs)),
			speechEndToVoiceStartMs: prev?.speechEndToVoiceStartMs ?? null
		}));
	}, [chatFirstTokenReceived]);
	return {
		beginVoiceCapture,
		endVoiceCapture,
		handleEditMessage,
		handleSpeakMessage,
		stopSpeaking,
		voice,
		voiceLatency
	};
}
function useGameModalMessages(options) {
	const { activeConversationId, companionMessageCutoffTs, isGameModal, visibleMsgs } = options;
	const previousCompanionCutoffTsRef = useRef(companionMessageCutoffTs);
	const previousGameModalVisibleMsgsRef = useRef([]);
	const previousActiveConversationIdRef = useRef(activeConversationId);
	const [companionNowMs, setCompanionNowMs] = useState(() => Date.now());
	const [companionCarryover, setCompanionCarryover] = useState(null);
	const docVisible = useDocumentVisibility();
	const gameModalRecentMsgs = useMemo(() => visibleMsgs.filter((message) => message.timestamp >= companionMessageCutoffTs), [companionMessageCutoffTs, visibleMsgs]);
	const gameModalContextMsgs = useMemo(() => {
		if (gameModalRecentMsgs.length > 0) return gameModalRecentMsgs;
		return visibleMsgs.slice(-COMPANION_VISIBLE_MESSAGE_LIMIT);
	}, [gameModalRecentMsgs, visibleMsgs]);
	const gameModalVisibleMsgs = useMemo(() => gameModalContextMsgs.slice(-COMPANION_VISIBLE_MESSAGE_LIMIT), [gameModalContextMsgs]);
	const gameModalCarryoverOpacity = useMemo(() => {
		if (!companionCarryover) return 0;
		if (companionNowMs < companionCarryover.fadeStartsAtMs) return 1;
		const remainingMs = companionCarryover.expiresAtMs - companionNowMs;
		if (remainingMs <= 0) return 0;
		return Math.max(0, remainingMs / COMPANION_HISTORY_FADE_MS);
	}, [companionCarryover, companionNowMs]);
	useEffect(() => {
		if (!isGameModal) {
			previousActiveConversationIdRef.current = activeConversationId;
			return;
		}
		if (previousActiveConversationIdRef.current === activeConversationId) return;
		previousActiveConversationIdRef.current = activeConversationId;
		previousGameModalVisibleMsgsRef.current = [];
		previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
		setCompanionCarryover(null);
	}, [
		activeConversationId,
		companionMessageCutoffTs,
		isGameModal
	]);
	useEffect(() => {
		if (!isGameModal) {
			previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
			return;
		}
		if (companionMessageCutoffTs > previousCompanionCutoffTsRef.current) {
			const carryoverMessages = previousGameModalVisibleMsgsRef.current.filter((message) => message.timestamp < companionMessageCutoffTs);
			if (carryoverMessages.length > 0) {
				const startedAtMs = Date.now();
				setCompanionCarryover({
					expiresAtMs: startedAtMs + COMPANION_HISTORY_HOLD_MS + COMPANION_HISTORY_FADE_MS,
					fadeStartsAtMs: startedAtMs + COMPANION_HISTORY_HOLD_MS,
					messages: carryoverMessages
				});
			} else setCompanionCarryover(null);
		}
		previousCompanionCutoffTsRef.current = companionMessageCutoffTs;
	}, [companionMessageCutoffTs, isGameModal]);
	useEffect(() => {
		previousGameModalVisibleMsgsRef.current = gameModalVisibleMsgs;
	}, [gameModalVisibleMsgs]);
	useEffect(() => {
		if (!companionCarryover) return;
		const tick = () => setCompanionNowMs(Date.now());
		tick();
		if (!docVisible) return () => {};
		const intervalId = window.setInterval(tick, 250);
		return () => window.clearInterval(intervalId);
	}, [companionCarryover, docVisible]);
	useEffect(() => {
		if (!companionCarryover) return;
		if (companionNowMs >= companionCarryover.expiresAtMs) setCompanionCarryover(null);
	}, [companionCarryover, companionNowMs]);
	return {
		companionCarryover,
		gameModalCarryoverOpacity,
		gameModalVisibleMsgs
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ChatView.js
const CHAT_INPUT_MIN_HEIGHT_PX = 46;
const CHAT_INPUT_MAX_HEIGHT_PX = 200;
const fallbackTranslate = (key, options) => typeof options?.defaultValue === "string" ? options.defaultValue : key;
function normalizeInboxChatSelection(value) {
	if (!value || typeof value !== "object") return null;
	const candidate = value;
	const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
	const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
	const source = typeof candidate.source === "string" ? candidate.source.trim() : "";
	const transportSource = typeof candidate.transportSource === "string" && candidate.transportSource.trim().length > 0 ? candidate.transportSource.trim() : void 0;
	if (!id || !title || !source && !transportSource) return null;
	return {
		avatarUrl: typeof candidate.avatarUrl === "string" ? candidate.avatarUrl : void 0,
		canSend: typeof candidate.canSend === "boolean" ? candidate.canSend : void 0,
		id,
		source,
		title,
		transportSource,
		worldId: typeof candidate.worldId === "string" ? candidate.worldId : void 0,
		worldLabel: typeof candidate.worldLabel === "string" ? candidate.worldLabel : void 0
	};
}
function ChatView({ variant = "default", onPtySessionClick }) {
	const app = useApp();
	const isGameModal = variant === "game-modal";
	const showComposerVoiceToggle = false;
	const { agentStatus, activeConversationId, activeInboxChat, activeTerminalSessionId, characterData, chatFirstTokenReceived, companionMessageCutoffTs, conversationMessages, handleChatSend, handleChatStop, handleChatEdit, elizaCloudConnected, elizaCloudVoiceProxyAvailable, elizaCloudHasPersistedKey, setState, copyToClipboard, droppedFiles: rawDroppedFiles, shareIngestNotice: rawShareIngestNotice, chatAgentVoiceMuted: agentVoiceMuted, selectedVrmIndex, uiLanguage, sendChatText, t: appTranslate } = app;
	const { ptySessions } = usePtySessions();
	const { chatInput: rawChatInput, chatSending, chatPendingImages: rawChatPendingImages, setChatPendingImages } = useChatComposer();
	const droppedFiles = Array.isArray(rawDroppedFiles) ? rawDroppedFiles : [];
	const chatInput = typeof rawChatInput === "string" ? rawChatInput : "";
	const shareIngestNotice = typeof rawShareIngestNotice === "string" ? rawShareIngestNotice : "";
	const chatPendingImages = Array.isArray(rawChatPendingImages) ? rawChatPendingImages : [];
	const inboxChat = useMemo(() => normalizeInboxChatSelection(activeInboxChat), [activeInboxChat]);
	const t = useCallback((key, values) => {
		if (typeof appTranslate === "function") return appTranslate(key, values);
		return (typeof values?.defaultValue === "string" ? values.defaultValue : key).replace(/\{\{(\w+)\}\}/g, (_match, token) => {
			const value = values?.[token];
			return value == null ? "" : String(value);
		});
	}, [appTranslate]);
	const messagesRef = useRef(null);
	const textareaRef = useRef(null);
	const fileInputRef = useRef(null);
	const composerRef = useRef(null);
	const [composerHeight, setComposerHeight] = useState(0);
	const [imageDragOver, setImageDragOver] = useState(false);
	const focusTerminalSession = useCallback((sessionId) => {
		setState("activeInboxChat", null);
		setState("activeTerminalSessionId", sessionId);
	}, [setState]);
	useEffect(() => {
		if (activeTerminalSessionId) return;
		const problemSession = ptySessions.find((s) => s.status === "error" || s.status === "blocked");
		if (problemSession) focusTerminalSession(problemSession.sessionId);
	}, [
		ptySessions,
		activeTerminalSessionId,
		focusTerminalSession
	]);
	const [codingAgentsAvailable, setCodingAgentsAvailable] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		fetchWithCsrf("/api/coding-agents/preflight", { signal: controller.signal }).then((r) => r.json()).then((data) => {
			setCodingAgentsAvailable(Array.isArray(data.installed) && data.installed.length > 0 || data.available === true);
		}).catch(() => {});
		return () => controller.abort();
	}, []);
	const handleCreateTask = useCallback((description, agentType) => {
		sendChatText(description, { metadata: {
			intent: "create_task",
			agentType
		} });
	}, [sendChatText]);
	const isAgentStarting = agentStatus?.state === "starting" || agentStatus?.state === "restarting";
	const hasCompletedLifecycleActivity = !chatSending && Array.isArray(conversationMessages) && conversationMessages.some((message) => message.role === "user" || message.role === "assistant" && message.text.trim().length > 0);
	const agentModel = typeof agentStatus?.model === "string" ? agentStatus.model.trim() : "";
	const isMissingInferenceProvider = agentStatus?.state === "running" && agentModel.length === 0;
	const isComposerLocked = isAgentStarting && !hasCompletedLifecycleActivity || isMissingInferenceProvider;
	const composerPlaceholderOverride = isMissingInferenceProvider ? t("chat.setupProviderToChat", { defaultValue: "Set up an LLM provider in Settings to start chatting" }) : void 0;
	const { beginVoiceCapture, endVoiceCapture, handleEditMessage, handleSpeakMessage, stopSpeaking, voice, voiceLatency } = useChatVoiceController({
		agentVoiceMuted,
		chatFirstTokenReceived,
		chatInput,
		chatSending,
		elizaCloudConnected,
		elizaCloudVoiceProxyAvailable,
		elizaCloudHasPersistedKey,
		conversationMessages,
		activeConversationId,
		handleChatEdit,
		handleChatSend,
		isComposerLocked,
		isGameModal,
		setState,
		uiLanguage
	});
	const prevConversationIdRef = useRef(activeConversationId);
	useLayoutEffect(() => {
		if (prevConversationIdRef.current === activeConversationId) return;
		prevConversationIdRef.current = activeConversationId;
		stopSpeaking();
	}, [activeConversationId, stopSpeaking]);
	const handleChatAvatarSpeakingChange = useCallback((isSpeaking) => {
		setState("chatAvatarSpeaking", isSpeaking);
	}, [setState]);
	const agentName = characterData?.name || agentStatus?.agentName || t("common.agent", { defaultValue: "Agent" });
	const msgs = Array.isArray(conversationMessages) ? conversationMessages : [];
	const visibleMsgs = useMemo(() => msgs.filter((msg) => !(chatSending && !chatFirstTokenReceived && msg.role === "assistant" && !msg.text.trim()) && !isRoutineCodingAgentMessage(msg)).map((msg) => msg.source ? msg : {
		...msg,
		source: "eliza"
	}), [
		chatFirstTokenReceived,
		chatSending,
		msgs
	]);
	const { companionCarryover, gameModalCarryoverOpacity, gameModalVisibleMsgs } = useGameModalMessages({
		activeConversationId,
		companionMessageCutoffTs,
		isGameModal,
		visibleMsgs
	});
	const agentAvatarSrc = selectedVrmIndex > 0 ? getVrmPreviewUrl(selectedVrmIndex) : null;
	useChatAvatarVoiceBridge({
		mouthOpen: voice.mouthOpen,
		isSpeaking: voice.isSpeaking,
		usingAudioAnalysis: voice.usingAudioAnalysis,
		onSpeakingChange: handleChatAvatarSpeakingChange
	});
	useEffect(() => {
		const displayedCompanionMessageCount = (companionCarryover?.messages.length ?? 0) + gameModalVisibleMsgs.length;
		if (!chatSending && visibleMsgs.length === 0 && (!isGameModal || displayedCompanionMessageCount === 0)) return;
		const el = messagesRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
		el.scrollTo({
			top: el.scrollHeight,
			behavior: nearBottom ? "instant" : "smooth"
		});
	}, [
		chatSending,
		companionCarryover,
		gameModalVisibleMsgs,
		isGameModal,
		visibleMsgs
	]);
	useEffect(() => {
		if (!isGameModal) return;
		const ta = textareaRef.current;
		if (!ta) return;
		if (!chatInput) {
			ta.style.height = `${CHAT_INPUT_MIN_HEIGHT_PX}px`;
			ta.style.overflowY = "hidden";
			return;
		}
		ta.style.height = "auto";
		ta.style.overflowY = "hidden";
		const h = Math.min(ta.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX);
		ta.style.height = `${h}px`;
		ta.style.overflowY = ta.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX ? "auto" : "hidden";
	}, [chatInput, isGameModal]);
	useEffect(() => {
		const el = composerRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) setComposerHeight(entry.contentRect.height);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const handleKeyDown = (e) => {
		if (isComposerLocked) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleChatSend();
		}
	};
	const addImageFiles = useCallback((files) => {
		const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
		if (!imageFiles.length) return;
		const readers = imageFiles.map((file) => new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result;
				const commaIdx = result.indexOf(",");
				resolve({
					data: commaIdx >= 0 ? result.slice(commaIdx + 1) : result,
					mimeType: file.type,
					name: file.name
				});
			};
			reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("Failed to read file"));
			reader.onabort = () => reject(/* @__PURE__ */ new Error("File read aborted"));
			reader.readAsDataURL(file);
		}));
		Promise.all(readers).then((attachments) => {
			setChatPendingImages((prev) => {
				return [...prev, ...attachments].slice(0, 4);
			});
		}).catch((err) => {
			console.warn("Failed to load image attachments:", err);
		});
	}, [setChatPendingImages]);
	const handleImageDrop = useCallback((e) => {
		e.preventDefault();
		setImageDragOver(false);
		if (e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files);
	}, [addImageFiles]);
	const handleFileInputChange = useCallback((e) => {
		if (e.target.files) addImageFiles(e.target.files);
		e.target.value = "";
	}, [addImageFiles]);
	const removeImage = useCallback((index) => {
		setChatPendingImages((prev) => prev.filter((_, i) => i !== index));
	}, [setChatPendingImages]);
	const chatMessageLabels = {
		cancel: t("common.cancel"),
		delete: t("aria.deleteMessage"),
		edit: t("aria.editMessage"),
		play: t("aria.playMessage"),
		responseInterrupted: t("chatmessage.ResponseInterrupte"),
		saveAndResend: t("chatmessage.SaveAndResend", { defaultValue: "Save and resend" }),
		saving: t("common.saving", { defaultValue: "Saving..." })
	};
	const messagesContent = visibleMsgs.length === 0 && !chatSending ? (0, import_jsx_runtime.jsx)("div", {
		className: "flex h-full items-center justify-center px-6 text-center text-xs text-muted",
		children: t("chatview.NoMessagesYet", { defaultValue: "No messages yet." })
	}) : (0, import_jsx_runtime.jsx)(ChatTranscript, {
		variant,
		agentName,
		carryoverMessages: companionCarryover?.messages,
		carryoverOpacity: gameModalCarryoverOpacity,
		labels: chatMessageLabels,
		messages: isGameModal ? gameModalVisibleMsgs : visibleMsgs,
		onEdit: handleEditMessage,
		onSpeak: handleSpeakMessage,
		onCopy: (text) => {
			copyToClipboard(text);
		},
		renderMessageContent: (message) => (0, import_jsx_runtime.jsx)(MessageContent, { message }),
		typingIndicator: chatSending && !chatFirstTokenReceived ? isGameModal ? (0, import_jsx_runtime.jsx)(TypingIndicator, {
			variant: "game-modal",
			agentName
		}) : (0, import_jsx_runtime.jsx)(TypingIndicator, {
			agentName,
			agentAvatarSrc
		}) : null
	});
	const auxiliaryNode = (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		shareIngestNotice ? (0, import_jsx_runtime.jsx)("div", {
			className: `text-xs text-ok py-1 relative${isGameModal ? " pointer-events-auto" : ""}`,
			style: { zIndex: 1 },
			children: shareIngestNotice
		}) : null,
		droppedFiles.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
			className: `text-xs text-muted py-0.5 flex gap-2 relative${isGameModal ? " pointer-events-auto" : ""}`,
			style: { zIndex: 1 },
			children: droppedFiles.map((f) => (0, import_jsx_runtime.jsx)("span", { children: f }, f))
		}) : null,
		(0, import_jsx_runtime.jsx)(ChatAttachmentStrip, {
			variant,
			items: chatPendingImages.map((img, imgIdx) => ({
				id: String(imgIdx),
				alt: img.name,
				name: img.name,
				src: `data:${img.mimeType};base64,${img.data}`
			})),
			removeLabel: (item) => t("chat.removeImage", {
				defaultValue: "Remove image {{name}}",
				name: item.name
			}),
			onRemove: (id) => removeImage(Number(id))
		}),
		voiceLatency ? (0, import_jsx_runtime.jsxs)("div", {
			className: `pb-1 text-2xs text-muted relative${isGameModal ? " pointer-events-auto" : ""}`,
			style: { zIndex: 1 },
			children: [
				t("chatview.SilenceEndFirstTo"),
				" ",
				voiceLatency.speechEndToFirstTokenMs ?? "—",
				t("chatview.msEndVoiceStart"),
				" ",
				voiceLatency.speechEndToVoiceStartMs ?? "—",
				t("chatview.msFirst"),
				" ",
				voiceLatency.firstSegmentCached == null ? "—" : voiceLatency.firstSegmentCached ? t("chat.cached", { defaultValue: "cached" }) : t("chat.uncached", { defaultValue: "uncached" })
			]
		}) : null,
		(0, import_jsx_runtime.jsx)("input", {
			ref: fileInputRef,
			type: "file",
			accept: "image/*",
			multiple: true,
			className: "hidden",
			onChange: handleFileInputChange
		})
	] });
	const defaultComposerLaneClassName = "mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8 xl:px-10";
	const defaultComposerShellClassName = `${defaultComposerLaneClassName} pt-1.5`;
	const composerNode = isGameModal ? (0, import_jsx_runtime.jsx)(ChatComposerShell, {
		variant: "game-modal",
		shellRef: composerRef,
		before: (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(CodingAgentControlChip, {}), (0, import_jsx_runtime.jsx)(AgentActivityBox, {
			sessions: ptySessions,
			onSessionClick: onPtySessionClick ?? focusTerminalSession
		})] }),
		children: (0, import_jsx_runtime.jsx)(ChatComposer, {
			variant: "game-modal",
			textareaRef,
			chatInput,
			chatPendingImagesCount: chatPendingImages.length,
			isComposerLocked,
			isAgentStarting,
			placeholder: composerPlaceholderOverride,
			chatSending,
			voice: {
				supported: voice.supported,
				isListening: voice.isListening,
				captureMode: voice.captureMode,
				interimTranscript: voice.interimTranscript,
				isSpeaking: voice.isSpeaking,
				assistantTtsQuality: voice.assistantTtsQuality,
				toggleListening: voice.toggleListening,
				startListening: beginVoiceCapture,
				stopListening: endVoiceCapture
			},
			agentVoiceEnabled: !agentVoiceMuted,
			showAgentVoiceToggle: showComposerVoiceToggle,
			t,
			onAttachImage: () => fileInputRef.current?.click(),
			onChatInputChange: (value) => setState("chatInput", value),
			onKeyDown: handleKeyDown,
			onSend: () => void handleChatSend(),
			onStop: handleChatStop,
			onStopSpeaking: stopSpeaking,
			onToggleAgentVoice: () => setState("chatAgentVoiceMuted", !agentVoiceMuted),
			codingAgentsAvailable,
			onCreateTask: handleCreateTask
		})
	}) : (0, import_jsx_runtime.jsx)(ChatComposerShell, {
		variant: "default",
		className: defaultComposerShellClassName,
		style: { paddingBottom: "calc(var(--safe-area-bottom, 0px) + var(--eliza-mobile-nav-offset, 0px) + 0.375rem)" },
		before: (0, import_jsx_runtime.jsx)(CodingAgentControlChip, {}),
		children: (0, import_jsx_runtime.jsx)(ChatComposer, {
			variant: "default",
			layout: "inline",
			textareaRef,
			chatInput,
			chatPendingImagesCount: chatPendingImages.length,
			isComposerLocked,
			isAgentStarting,
			placeholder: composerPlaceholderOverride,
			chatSending,
			voice: {
				supported: voice.supported,
				isListening: voice.isListening,
				captureMode: voice.captureMode,
				interimTranscript: voice.interimTranscript,
				isSpeaking: voice.isSpeaking,
				assistantTtsQuality: voice.assistantTtsQuality,
				toggleListening: voice.toggleListening,
				startListening: beginVoiceCapture,
				stopListening: endVoiceCapture
			},
			agentVoiceEnabled: !agentVoiceMuted,
			showAgentVoiceToggle: showComposerVoiceToggle,
			t,
			onAttachImage: () => fileInputRef.current?.click(),
			onChatInputChange: (value) => setState("chatInput", value),
			onKeyDown: handleKeyDown,
			onSend: () => void handleChatSend(),
			onStop: handleChatStop,
			onStopSpeaking: stopSpeaking,
			onToggleAgentVoice: () => setState("chatAgentVoiceMuted", !agentVoiceMuted),
			codingAgentsAvailable,
			onCreateTask: handleCreateTask
		})
	});
	if (activeTerminalSessionId) return (0, import_jsx_runtime.jsx)(TerminalChannelPanel, {
		activeSessionId: activeTerminalSessionId,
		sessions: ptySessions,
		onClose: () => setState("activeTerminalSessionId", null),
		loadingLabel: t("terminal.starting", { defaultValue: "Starting terminal…" })
	});
	if (inboxChat) return (0, import_jsx_runtime.jsx)(InboxChatPanel, {
		activeInboxChat: inboxChat,
		variant
	}, inboxChat.id);
	return (0, import_jsx_runtime.jsx)(ChatThreadLayout, {
		"aria-label": t("aria.chatWorkspace"),
		variant,
		composerHeight,
		imageDragOver,
		messagesRef,
		footerStack: (0, import_jsx_runtime.jsx)("div", {
			className: defaultComposerLaneClassName,
			children: auxiliaryNode
		}),
		composer: composerNode,
		onDragOver: (event) => {
			event.preventDefault();
			setImageDragOver(true);
		},
		onDragLeave: () => setImageDragOver(false),
		onDrop: handleImageDrop,
		children: messagesContent
	});
}
/**
* Full-window terminal view rendered when the Terminal channel is
* active. Keeps every PTY session pane mounted under the hood so
* tabbing between sessions preserves their buffers/state. Spawning is
* owned by the sidebar — this component only displays what the
* orchestrator has already registered, and waits for the live session
* list to catch up when activeSessionId is set but not yet present.
*/
function TerminalChannelPanel({ activeSessionId, sessions, onClose, loadingLabel }) {
	if (!sessions.some((s) => s.sessionId === activeSessionId)) return (0, import_jsx_runtime.jsx)("div", {
		"data-testid": "terminal-channel-loading",
		className: "flex flex-1 items-center justify-center text-xs text-muted",
		children: loadingLabel
	});
	return (0, import_jsx_runtime.jsx)("div", {
		"data-testid": "terminal-channel-panel",
		className: "flex flex-1 min-h-0 min-w-0 flex-col",
		children: (0, import_jsx_runtime.jsx)(PtyConsoleBase, {
			activeSessionId,
			sessions,
			onClose,
			variant: "full"
		})
	});
}
/**
* Connector chat panel shown when the messages sidebar has a
* room selected. Polls `/api/inbox/messages?roomId=...`, renders the
* transcript through the same ChatTranscript component the dashboard
* uses, and routes outbound replies back through the runtime's
* source-specific send handlers.
*/
function InboxChatPanel({ activeInboxChat, variant }) {
	const t = useApp()?.t ?? fallbackTranslate;
	const [messages, setMessages] = useState([]);
	const [loading, setLoading] = useState(true);
	const [replyText, setReplyText] = useState("");
	const [replyError, setReplyError] = useState(null);
	const [sending, setSending] = useState(false);
	const scrollRef = useRef(null);
	const inboxTextareaRef = useRef(null);
	const lastRenderedMessageKeyRef = useRef(null);
	const transportSource = activeInboxChat.transportSource ?? activeInboxChat.source;
	const loadInboxMessages = useCallback(async () => {
		try {
			setMessages([...(await client.getInboxMessages({
				limit: 200,
				roomId: activeInboxChat.id,
				roomSource: transportSource
			})).messages].reverse().map((m) => m));
		} catch {} finally {
			setLoading(false);
		}
	}, [activeInboxChat.id, transportSource]);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			await loadInboxMessages();
			if (cancelled) return;
		})();
		return () => {
			cancelled = true;
		};
	}, [loadInboxMessages]);
	useIntervalWhenDocumentVisible(() => {
		loadInboxMessages();
	}, 15e3);
	useLayoutEffect(() => {
		if (messages.length === 0) return;
		const el = scrollRef.current;
		if (!el) return;
		const lastMessage = messages[messages.length - 1];
		const nextKey = `${messages.length}:${lastMessage?.id ?? ""}:${lastMessage?.timestamp ?? 0}`;
		if (lastRenderedMessageKeyRef.current === nextKey) return;
		el.scrollTo({
			top: el.scrollHeight,
			behavior: lastRenderedMessageKeyRef.current === null ? "instant" : "smooth"
		});
		lastRenderedMessageKeyRef.current = nextKey;
	}, [messages]);
	const sourceLabel = activeInboxChat.source ? activeInboxChat.source.charAt(0).toUpperCase() + activeInboxChat.source.slice(1) : t("common.channel", { defaultValue: "Channel" });
	const handleReplySend = useCallback(async () => {
		const text = replyText.trim();
		if (!text || sending || activeInboxChat.canSend === false) return;
		setSending(true);
		setReplyError(null);
		try {
			const response = await client.sendInboxMessage({
				roomId: activeInboxChat.id,
				source: transportSource,
				text
			});
			if (response.message) setMessages((current) => [...current, response.message]);
			setReplyText("");
		} catch (error) {
			setReplyError(error instanceof Error ? error.message : t("inboxview.SendFailed", { defaultValue: "Failed to send message." }));
		} finally {
			setSending(false);
		}
	}, [
		activeInboxChat.canSend,
		activeInboxChat.id,
		replyText,
		sending,
		t,
		transportSource
	]);
	const handleReplyKeyDown = useCallback((event) => {
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		handleReplySend();
	}, [handleReplySend]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-1 min-h-0 min-w-0 flex-col",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between px-5 py-3",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "text-sm font-bold text-txt truncate",
						children: activeInboxChat.title
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-0.5 text-xs-tight text-muted",
						children: [
							activeInboxChat.worldLabel ? `${activeInboxChat.worldLabel} • ` : "",
							sourceLabel,
							" · ",
							messages.length,
							" ",
							t("inboxview.TotalCountShort", { defaultValue: "messages" })
						]
					})]
				}), activeInboxChat.source ? (0, import_jsx_runtime.jsx)(ChatSourceIcon, {
					source: activeInboxChat.source,
					className: "h-4 w-4"
				}) : activeInboxChat.avatarUrl ? (0, import_jsx_runtime.jsx)("img", {
					src: activeInboxChat.avatarUrl,
					alt: t("inboxview.avatarAlt", {
						defaultValue: "{{title}} avatar",
						title: activeInboxChat.title
					}),
					className: "h-8 w-8 shrink-0 rounded-full border border-border/35 object-cover shadow-[0_10px_18px_-16px_rgba(15,23,42,0.45)]"
				}) : null]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				ref: scrollRef,
				"data-testid": "inbox-chat-scroll",
				className: "flex-1 min-h-0 overflow-y-auto px-5 py-4",
				children: loading && messages.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
					className: "flex h-full items-center justify-center text-xs text-muted",
					children: t("inboxview.Loading", { defaultValue: "Loading messages…" })
				}) : messages.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
					className: "flex h-full items-center justify-center text-center text-xs text-muted",
					children: t("inboxview.EmptyRoom", { defaultValue: "No messages in this chat yet." })
				}) : (0, import_jsx_runtime.jsx)(ChatTranscript, {
					variant,
					messages,
					userMessagesOnRight: false,
					renderMessageContent: (message) => (0, import_jsx_runtime.jsx)(MessageContent, { message })
				})
			}),
			activeInboxChat.canSend === false ? (0, import_jsx_runtime.jsx)("div", {
				className: "bg-bg-hover/40 px-5 py-3 text-xs-tight leading-5 text-muted",
				children: t("inboxview.ReadOnlyReplyHint", {
					defaultValue: "This {{source}} chat is readable, but outbound replies are not available for this connector yet.",
					source: sourceLabel
				})
			}) : (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col gap-2 px-3 pb-3",
				children: [
					(0, import_jsx_runtime.jsx)("div", {
						className: "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-2xs leading-snug text-warn",
						children: t("inboxview.AgentSendWarning", {
							defaultValue: "This message will be sent as your agent in {{source}}.",
							source: sourceLabel
						})
					}),
					(0, import_jsx_runtime.jsx)(ChatComposerShell, {
						variant: "default",
						children: (0, import_jsx_runtime.jsx)(ChatComposer, {
							variant: "default",
							textareaRef: inboxTextareaRef,
							chatInput: replyText,
							chatPendingImagesCount: 0,
							isComposerLocked: sending,
							isAgentStarting: false,
							chatSending: sending,
							voice: inertVoiceState,
							agentVoiceEnabled: false,
							showAgentVoiceToggle: false,
							t,
							hideAttachButton: true,
							placeholder: t("inboxview.ReplyPlaceholder", {
								defaultValue: "Reply in {{source}}",
								source: sourceLabel
							}),
							onAttachImage: () => {},
							onChatInputChange: setReplyText,
							onKeyDown: handleReplyKeyDown,
							onSend: () => void handleReplySend(),
							onStop: () => {},
							onStopSpeaking: () => {},
							onToggleAgentVoice: () => {}
						})
					}),
					replyError ? (0, import_jsx_runtime.jsx)("div", {
						className: "px-1 text-xs-tight text-danger",
						children: replyError
					}) : null
				]
			})
		]
	});
}
const inertVoiceState = {
	assistantTtsQuality: void 0,
	captureMode: "idle",
	interimTranscript: "",
	isListening: false,
	isSpeaking: false,
	startListening: () => {},
	stopListening: () => {},
	supported: false,
	toggleListening: () => {}
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/page-scoped-conversations.js
const PAGE_SCOPE_ROUTING_CONTEXTS = {
	"page-browser": {
		primaryContext: "browser",
		secondaryContexts: [
			"page",
			"page-browser",
			"browser",
			"knowledge"
		]
	},
	"page-character": {
		primaryContext: "character",
		secondaryContexts: [
			"page",
			"page-character",
			"character",
			"knowledge",
			"social"
		]
	},
	"page-automations": {
		primaryContext: "automation",
		secondaryContexts: [
			"page",
			"page-automations",
			"automation"
		]
	},
	"page-apps": {
		primaryContext: "apps",
		secondaryContexts: [
			"page",
			"page-apps",
			"apps"
		]
	},
	"page-connectors": {
		primaryContext: "connectors",
		secondaryContexts: [
			"page",
			"page-connectors",
			"connectors",
			"social"
		]
	},
	"page-phone": {
		primaryContext: "phone",
		secondaryContexts: [
			"page",
			"page-phone",
			"phone",
			"social"
		]
	},
	"page-plugins": {
		primaryContext: "plugins",
		secondaryContexts: [
			"page",
			"page-plugins",
			"plugins",
			"system"
		]
	},
	"page-lifeops": {
		primaryContext: "lifeops",
		secondaryContexts: [
			"page",
			"page-lifeops",
			"lifeops",
			"automation",
			"social"
		]
	},
	"page-settings": {
		primaryContext: "settings",
		secondaryContexts: [
			"page",
			"page-settings",
			"settings",
			"system"
		]
	},
	"page-wallet": {
		primaryContext: "wallet",
		secondaryContexts: [
			"page",
			"page-wallet",
			"wallet"
		]
	}
};
/**
* Bump when the per-scope brief, intro copy, or live-state shape changes
* meaningfully — so a future MIPRO/GEPA optimization pass can filter to a
* single prompt-regime cohort instead of mixing trajectories generated under
* different surface contracts.
*/
const PAGE_SCOPE_VERSION = 13;
const PAGE_SCOPE_COPY = {
	"page-browser": {
		title: "Browser chat",
		body: "Use me to drive the browser while you watch. I narrate each step here as a short status line; you confirm transactions in the wallet sheet. User Tabs are writable; Agent Tabs and App Tabs are read-only context.",
		systemAddendum: "You are answering inside the Browser view in watch mode: the user is watching a visible cursor move and the browser tab paint live as you work. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate User Tabs: open them, navigate them, refresh them, snapshot them, show or hide them, and close them. Agent Tabs and App Tabs are read-only context — never navigate, click, type into, refresh, close, or otherwise mutate them. When you take a browser action, recommend and prefer the realistic-* BROWSER_SESSION subactions (realistic-click, realistic-fill, realistic-type, realistic-press) with watchMode:true so the cursor moves visibly and pointer/keyboard events fire faithfully on React-controlled inputs. Emit a short status line in chat BEFORE each concrete action — for example 'Navigating to four.meme', 'Choosing token name: $WAGMI', 'Filling description', 'Submitting — please confirm in your wallet'. Keep narration to one line per step. Never auto-sign transactions; the user confirms each one in the wallet approval sheet. Ground every answer in the live tab list provided in context. Never invent tabs or URLs."
	},
	"page-character": {
		title: "Character chat",
		body: "Use me to work with the Character hub. I can help you review Overview, refine Personality, manage Knowledge, inspect Skills, inspect Experience, and explore Relationships. Recommended: tell me what you want to change or understand, and I'll point to the right section or draft exact copy. Ask me what to update next.",
		systemAddendum: "You are answering inside the Character view. The Character hub is organized into Overview, Personality, Knowledge, Skills, Experience, and Relationships. Help the user navigate those sections, recommend the next character step from live state, and draft exact wording when they need copy. Use Overview for high-level status and identity framing, Personality for editable persona/voice fields, Knowledge for uploaded reference material, Skills for learned skill proposals and status, Experience for surfaced learnings, and Relationships for contact and graph context. Guide the user to the relevant section instead of inventing a generic setter action. Reference live character state when answering."
	},
	"page-automations": {
		title: "Automations",
		body: "Use me to create or inspect a task or n8n workflow. Tell me the trigger, timing, and result.",
		systemAddendum: "You are answering inside the Automations view. The user can create tasks and n8n workflows, attach either one to a schedule or event, configure wake mode, max runs, and enabled state, browse templates, inspect existing automations, and troubleshoot failed runs. Treat tasks as simple prompt-driven automations and workflows as multi-step n8n pipelines. Recommend the smaller task shape unless the user clearly needs a multi-step pipeline. When the user describes a concrete automation, dispatch it via the planner's <actions> field using <action><name>CREATE_TRIGGER_TASK</name></action> for scheduled or event tasks, or <action><name>MANAGE_TASKS</name></action> for task list operations. Reference live tasks and workflows in context by display name. Never fabricate automation names."
	},
	"page-apps": {
		title: "Apps chat",
		body: "Use me to browse the catalog, compare apps, launch an app, stop a running app, open a live viewer, inspect run health, and manage favorites or recent apps. Recommended: describe the outcome you want, and I'll suggest the right app or launch it. Ask me about any catalog item or running app.",
		systemAddendum: "You are answering inside the Apps view. The user can browse the catalog, compare apps by category and capability, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Recommend the best app or next run-management action based on live catalog and run state. Use APP with mode launch, relaunch, list, load_from_directory, or create when the request is concrete. Refer to apps by display name and never invent app names."
	},
	"page-connectors": {
		title: "Connectors chat",
		body: "Use me to inspect connector readiness, setup steps, auth state, and integration health. Recommended: ask what to connect or troubleshoot.",
		systemAddendum: "You are answering inside the Connectors view. The user can inspect connector availability, authentication state, setup requirements, and integration health. Recommend the smallest connector action that fits the user's goal, reference visible connector state when present, and never invent connected accounts, permissions, webhook state, or delivery results."
	},
	"page-phone": {
		title: "Phone chat",
		body: "Use me to review calls, SMS, contacts, imported vCards, caller context, and transcript notes. Recommended: ask me to draft a reply, summarize a call, decide who to call back, or organize a contact from the phone workspace. Ask me what to do with any visible call or message.",
		systemAddendum: "You are answering inside the Android Phone view. The user can place calls through Android Telecom, open the dialer, send SMS through Android SMS, review recent calls, browse contacts, import vCards, and save call transcripts or summaries. Recommend the smallest concrete phone action that fits the user's goal. For calls or SMS, confirm the target number/contact and message content before sending. When discussing calls, messages, contacts, or transcripts, ground the answer in visible phone surface state when present and never invent call logs, contacts, message bodies, transcripts, or delivery results."
	},
	"page-plugins": {
		title: "Plugins chat",
		body: "Use me to inspect installed plugins, configuration gaps, registry options, and runtime plugin health.",
		systemAddendum: "You are answering inside the Plugins view. The user can inspect installed plugins, registry plugins, configuration readiness, plugin health, and runtime capability gaps. Recommend the smallest plugin setup or troubleshooting action that fits the user's goal, reference visible plugin state when present, and never invent installed plugins, credentials, or enabled capabilities."
	},
	"page-lifeops": {
		title: "LifeOps chat",
		body: "Ask me about the visible LifeOps item or the next action you want handled.",
		systemAddendum: "You are answering inside the LifeOps view. The user can inspect the current overview, goals, reminders, calendar, messages, mail, sleep, screen time, social context, connector setup, capability readiness, and LifeOps settings. Recommend capability readiness and overview review before creating or changing durable personal workflows. When the user asks for concrete LifeOps work, route through the LifeOps app actions/providers already available in the runtime instead of generic advice. Reference live LifeOps state when present, and never invent reminders, goals, messages, calendar events, or connector state."
	},
	"page-settings": {
		title: "Settings chat",
		body: "Use me to tune models, providers, permissions, connectors, wallet RPC, cloud account state, appearance, updates, and feature toggles. Recommended: describe the capability you want to enable or troubleshoot, and I'll point to the right section or explain the tradeoffs.",
		systemAddendum: "You are answering inside the Settings view. The user can change cloud account state, AI models and providers, permissions, wallet RPC providers, feature toggles, appearance, updates, and connector-related configuration. Recommend the smallest concrete settings change that fits the user's goal and reference the visible section when possible. Ask follow-up questions when a setting affects security, spending, or external accounts. Never invent provider status, account state, or permission grants."
	},
	"page-wallet": {
		title: "Wallet chat",
		body: "Use me to inspect token inventory, NFTs, LP positions, balances, P&L, activity, EVM/Solana addresses, RPC readiness, native Hyperliquid/Polymarket readiness, and Vincent delegated trading. Recommended: ask me to prepare a swap, bridge, market review, or delegated trading plan with the amount and constraints you want.",
		systemAddendum: "You are answering inside the Wallet view. The user can inspect token inventory, NFTs, LP positions, current balance, P&L, activity, EVM/Solana addresses, RPC/provider readiness, wallet/RPC settings, native Hyperliquid and Polymarket readiness, and Vincent delegated trading. There are no chain filters in this surface. Recommend the smallest concrete wallet action that fits the user's goal. For swaps, bridges, transfers, signatures, trading actions, or prediction-market actions, confirm the asset/market, amount, destination/outcome, slippage/risk limits, and execution path before invoking available wallet actions. If the user asks about Hyperliquid or Polymarket, prefer the native app surfaces for reads/status and only surface Vincent for delegated automated trading. Never invent balances, positions, fills, markets, odds, or execution support."
	}
};
const PAGE_SCOPE_DEFAULT_TITLE = {
	"page-browser": "Browser",
	"page-character": "Character",
	"page-automations": "Automations",
	"page-apps": "Apps",
	"page-connectors": "Connectors",
	"page-phone": "Phone",
	"page-plugins": "Plugins",
	"page-lifeops": "LifeOps",
	"page-settings": "Settings",
	"page-wallet": "Wallet"
};
/**
* Browser scope intro copy varies by Agent Browser Bridge companion state: when the
* extension is connected the agent can drive real tabs; when it isn't the
* intro has to walk the user through installing the extension instead of
* pretending real-browser control is available.
*/
function getBrowserPageScopeCopy(state) {
	if (state.browserBridgeConnected) {
		const browser = state.browserLabel?.trim() || "Chrome";
		const profile = state.profileLabel?.trim();
		const where = profile ? `${browser} / ${profile}` : browser;
		return {
			title: "Browser chat",
			body: `Agent Browser Bridge is connected in ${where}. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Use me to open, navigate, refresh, snapshot, show, hide, or close User Tabs and explain what is currently open in any tab.`,
			systemAddendum: `You are answering inside the Browser view. Agent Browser Bridge is connected in ${where}. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate User Tabs: open them, navigate them, refresh them, snapshot them, show or hide them, and close them. Agent Tabs and App Tabs are read-only context: you may inspect, summarize, or reference them, but do not navigate, click, type into, refresh, close, or otherwise mutate them. Recommend the next browser action based on the live tab list. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.`
		};
	}
	if (state.browserBridgeInstallAvailable === false) return {
		title: "Browser chat",
		body: "Use me with the embedded browser in this view. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Real Chrome control is unavailable in the current runtime, so I can help with embedded User Tabs, navigation, forms, and page questions only.",
		systemAddendum: "You are answering inside the Browser view. Agent Browser Bridge is not available in this runtime, so real Chrome control cannot be enabled from this session. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate embedded User Tabs only. Agent Tabs and App Tabs remain read-only context. Help the user with the embedded browser only: opening User Tabs, navigating URLs, refreshing pages, and answering questions about the current embedded page or tab list. Do not recommend installing Agent Browser Bridge or promise real-browser tab control."
	};
	return {
		title: "Install Agent Browser Bridge",
		body: "Install Agent Browser Bridge so I can drive real Chrome tabs. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Until it connects, I can still help with the embedded browser.",
		systemAddendum: "You are answering inside the Browser view. The user has NOT installed the Agent Browser Bridge companion extension yet. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate embedded User Tabs only. Agent Tabs and App Tabs are read-only context. Guide them to click the Install Agent Browser Bridge button visible in this chat panel — it builds the extension and opens Chrome's extension manager so they can load the unpacked folder. Recommend connecting the extension before requests that need real Chrome control. Until the extension is connected, only the embedded iframe browser is available; do not invent real-browser tabs or promise real-tab control. Offer to answer setup questions or help with embedded browsing."
	};
}
function isPageScopedConversation(conversation) {
	const scope = conversation?.metadata?.scope;
	return typeof scope === "string" && scope.startsWith("page-");
}
function buildPageScopedConversationMetadata(scope, options = {}) {
	const metadata = { scope };
	if (options.pageId) metadata.pageId = options.pageId;
	if (options.sourceConversationId) metadata.sourceConversationId = options.sourceConversationId;
	return metadata;
}
/**
* Routing metadata stamped on every page-scope send. The runtime persists this
* into the trajectory `metadata` column verbatim — every field here is a
* sortable dimension for later analysis or per-scope prompt optimization.
*/
function buildPageScopedRoutingMetadata(scope, options = {}) {
	const routing = PAGE_SCOPE_ROUTING_CONTEXTS[scope];
	const metadata = {
		__responseContext: {
			primaryContext: routing.primaryContext,
			secondaryContexts: routing.secondaryContexts
		},
		taskId: scope,
		surface: "page-scoped",
		surfaceVersion: PAGE_SCOPE_VERSION
	};
	if (options.pageId) metadata.pageId = options.pageId;
	if (options.sourceConversationId) metadata.sourceConversationId = options.sourceConversationId;
	return metadata;
}
function findPageScopedConversation(conversations, scope, pageId) {
	const matching = conversations.filter((conversation) => conversation.metadata?.scope === scope && (conversation.metadata?.pageId ?? void 0) === (pageId ?? void 0));
	if (matching.length === 0) return null;
	return matching.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
}
function findPageScopedConversations(conversations, scope, pageId) {
	return conversations.filter((conversation) => conversation.metadata?.scope === scope && (conversation.metadata?.pageId ?? void 0) === (pageId ?? void 0)).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}
async function resolvePageScopedConversation(params) {
	const { scope, pageId } = params;
	const title = params.title?.trim() || PAGE_SCOPE_DEFAULT_TITLE[scope];
	const desiredMetadata = buildPageScopedConversationMetadata(scope, { pageId });
	const { conversations } = await client.listConversations();
	const existing = findPageScopedConversation(conversations, scope, pageId);
	if (existing) {
		const titleMatches = existing.title === title;
		const metadataMatches = existing.metadata?.scope === scope && (existing.metadata?.pageId ?? void 0) === (pageId ?? void 0);
		if (titleMatches && metadataMatches) return existing;
		const { conversation } = await client.updateConversation(existing.id, {
			title,
			metadata: desiredMetadata
		});
		return conversation;
	}
	const { conversation } = await client.createConversation(title, { metadata: desiredMetadata });
	return conversation;
}
async function resetPageScopedConversation(params) {
	const { scope, pageId } = params;
	const title = params.title?.trim() || PAGE_SCOPE_DEFAULT_TITLE[scope];
	const desiredMetadata = buildPageScopedConversationMetadata(scope, { pageId });
	const { conversations } = await client.listConversations();
	const matching = findPageScopedConversations(conversations, scope, pageId);
	if (matching.length > 0) await Promise.allSettled(matching.map((conversation) => client.deleteConversation(conversation.id)));
	const { conversation } = await client.createConversation(title, { metadata: desiredMetadata });
	return conversation;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/PageScopedChatPane.js
const MAX_PAGE_CHAT_IMAGES = 4;
const CHAT_PREFILL_EVENT = "eliza:chat:prefill";
async function getPageScopedConversationMessages(conversationId) {
	try {
		const { messages } = await client.getConversationMessages(conversationId);
		return messages;
	} catch {
		return [];
	}
}
function readChatPrefillDetail(event) {
	const detail = event.detail;
	if (!detail || typeof detail.text !== "string" || detail.text.length === 0) return null;
	return detail;
}
function resolveSpeechLocale(uiLanguage) {
	switch (uiLanguage) {
		case "zh-CN": return "zh-CN";
		case "ko": return "ko-KR";
		case "es": return "es-ES";
		case "pt": return "pt-BR";
		case "vi": return "vi-VN";
		case "tl": return "fil-PH";
		default: return "en-US";
	}
}
function shallowEqual(left, right) {
	if (left === right) return true;
	if (!left || !right) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((k) => left[k] === right[k]);
}
function PageScopedChatPane({ scope, pageId, title, className, introOverride, systemAddendumOverride, placeholderOverride, persistentIntro = false, footerActions, conversationAdapter }) {
	const copy = PAGE_SCOPE_COPY[scope];
	const introTitle = introOverride?.title ?? copy.title;
	const introBody = introOverride?.body ?? copy.body;
	const introActions = introOverride?.actions ?? null;
	const effectiveSystemAddendum = systemAddendumOverride ?? copy.systemAddendum;
	const placeholder = placeholderOverride ?? "Message";
	const app = useApp();
	const composerRef = useRef(null);
	const fileInputRef = useRef(null);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);
	const conversationAdapterRef = useRef(conversationAdapter);
	const [conversation, setConversation] = useState(null);
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [pendingImages, setPendingImages] = useState([]);
	const [attachmentError, setAttachmentError] = useState(null);
	const [imageDragOver, setImageDragOver] = useState(false);
	const [voicePreview, setVoicePreview] = useState("");
	const [sending, setSending] = useState(false);
	const [firstTokenReceived, setFirstTokenReceived] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [loadError, setLoadError] = useState(null);
	const conversationAdapterIdentityKey = conversationAdapter?.identityKey;
	const hasConversationAdapter = Boolean(conversationAdapter);
	useEffect(() => {
		conversationAdapterRef.current = conversationAdapter;
	}, [conversationAdapter]);
	const sourceConversationId = useMemo(() => {
		const activeId = app.activeConversationId;
		if (!activeId) return void 0;
		if (conversation && activeId === conversation.id) return void 0;
		const active = app.conversations.find((c) => c.id === activeId);
		if (!active) return void 0;
		if (isPageScopedConversation(active)) return void 0;
		if (active.metadata?.scope?.startsWith("automation-")) return void 0;
		return activeId;
	}, [
		app.activeConversationId,
		app.conversations,
		conversation
	]);
	useEffect(() => {
		let cancelled = false;
		abortRef.current?.abort();
		setConversation(null);
		setMessages([]);
		setInput("");
		setPendingImages([]);
		setAttachmentError(null);
		setImageDragOver(false);
		setVoicePreview("");
		setSending(false);
		setFirstTokenReceived(false);
		setLoadError(null);
		(async () => {
			try {
				const adapter = conversationAdapterRef.current;
				const next = adapter ? await adapter.resolveConversation() : await resolvePageScopedConversation({
					scope,
					title,
					pageId
				});
				if (cancelled) return;
				setConversation(next);
				adapter?.onConversationResolved?.(next);
				const history = await getPageScopedConversationMessages(next.id);
				if (cancelled) return;
				setMessages(history);
			} catch (cause) {
				if (cancelled) return;
				setLoadError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : "Failed to load page chat.");
			}
		})();
		return () => {
			cancelled = true;
			abortRef.current?.abort();
		};
	}, [
		conversationAdapterIdentityKey,
		pageId,
		scope,
		title
	]);
	useEffect(() => {
		if (hasConversationAdapter) return;
		if (!conversation) return;
		const desiredSource = sourceConversationId;
		if (desiredSource === (conversation.metadata?.sourceConversationId ?? void 0)) return;
		const desiredMetadata = buildPageScopedConversationMetadata(scope, {
			pageId,
			sourceConversationId: desiredSource
		});
		if (shallowEqual(conversation.metadata, desiredMetadata)) return;
		let cancelled = false;
		(async () => {
			try {
				const { conversation: next } = await client.updateConversation(conversation.id, { metadata: desiredMetadata });
				if (!cancelled) setConversation(next);
			} catch {}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		conversation,
		hasConversationAdapter,
		sourceConversationId,
		scope,
		pageId
	]);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
		if (typeof el.scrollTo === "function") {
			el.scrollTo({
				top: el.scrollHeight,
				behavior: nearBottom ? "auto" : "smooth"
			});
			return;
		}
		el.scrollTop = el.scrollHeight;
	}, [`${messages.length}:${sending ? "sending" : "idle"}`]);
	const handleSend = useCallback(async (options) => {
		const raw = (options?.text ?? input).trim();
		const images = options?.images ?? pendingImages;
		if (!raw && images.length === 0 || !conversation || sending) return;
		const textToSend = messages.length === 0 ? `[SYSTEM]${effectiveSystemAddendum}[/SYSTEM]\n\n${raw}` : raw;
		const routingMetadata = conversationAdapter?.buildRoutingMetadata?.() ?? buildPageScopedRoutingMetadata(scope, {
			pageId,
			sourceConversationId
		});
		const now = Date.now();
		const userId = `page-${scope}-user-${now}`;
		const assistantId = `page-${scope}-assistant-${now}`;
		setMessages((prev) => [
			...prev,
			{
				id: userId,
				images: images.length > 0 ? images : void 0,
				role: "user",
				text: raw,
				timestamp: now
			},
			{
				id: assistantId,
				role: "assistant",
				text: "",
				timestamp: now
			}
		]);
		setInput("");
		setPendingImages([]);
		setAttachmentError(null);
		setVoicePreview("");
		setSending(true);
		setFirstTokenReceived(false);
		const controller = new AbortController();
		abortRef.current = controller;
		let streamed = "";
		try {
			const response = await client.sendConversationMessageStream(conversation.id, textToSend, (token) => {
				if (!token) return;
				const delta = token.slice(streamed.length);
				if (!delta) return;
				streamed += delta;
				setFirstTokenReceived(true);
				setMessages((prev) => prev.map((m) => m.id === assistantId ? {
					...m,
					text: m.text + delta
				} : m));
			}, options?.channelType ?? "DM", controller.signal, images.length > 0 ? images : void 0, void 0, routingMetadata);
			if (response.text && response.text !== streamed) setMessages((prev) => prev.map((m) => m.id === assistantId ? {
				...m,
				text: response.text
			} : m));
			conversationAdapter?.onAfterSend?.();
		} catch (error) {
			if (error.name === "AbortError") return;
			setMessages((prev) => prev.map((m) => m.id === assistantId ? {
				...m,
				text: "Sorry — that didn't go through. Try again?"
			} : m));
		} finally {
			setSending(false);
			abortRef.current = null;
			composerRef.current?.focus();
		}
	}, [
		conversation,
		effectiveSystemAddendum,
		input,
		messages.length,
		pageId,
		pendingImages,
		conversationAdapter,
		scope,
		sending,
		sourceConversationId
	]);
	const handleStop = useCallback(() => {
		abortRef.current?.abort();
	}, []);
	const disabled = !conversation || Boolean(loadError);
	const addImageFiles = useCallback((files) => {
		const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, MAX_PAGE_CHAT_IMAGES);
		if (imageFiles.length === 0) return;
		setAttachmentError(null);
		const readers = imageFiles.map((file) => new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = typeof reader.result === "string" ? reader.result : "";
				const commaIndex = result.indexOf(",");
				resolve({
					data: commaIndex >= 0 ? result.slice(commaIndex + 1) : result,
					mimeType: file.type,
					name: file.name
				});
			};
			reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("Failed to read image"));
			reader.onabort = () => reject(/* @__PURE__ */ new Error("Image read aborted"));
			reader.readAsDataURL(file);
		}));
		Promise.all(readers).then((attachments) => {
			setPendingImages((prev) => [...prev, ...attachments].slice(0, MAX_PAGE_CHAT_IMAGES));
		}).catch(() => {
			setAttachmentError("Failed to load image attachment.");
		});
	}, []);
	const handleFileInputChange = useCallback((event) => {
		if (event.target.files) addImageFiles(event.target.files);
		event.target.value = "";
	}, [addImageFiles]);
	const handleImageDrop = useCallback((event) => {
		event.preventDefault();
		setImageDragOver(false);
		if (event.dataTransfer.files.length > 0) addImageFiles(event.dataTransfer.files);
	}, [addImageFiles]);
	const removeImage = useCallback((index) => {
		setPendingImages((prev) => prev.filter((_, current) => current !== index));
	}, []);
	const voice = useVoiceChat({
		cloudConnected: app.elizaCloudVoiceProxyAvailable || app.elizaCloudConnected || false,
		interruptOnSpeech: false,
		lang: resolveSpeechLocale(app.uiLanguage),
		onTranscript: (text) => {
			const transcript = text.trim();
			if (!transcript) return;
			setVoicePreview("");
			handleSend({
				channelType: "VOICE_DM",
				images: [],
				text: transcript
			});
		},
		onTranscriptPreview: (text) => {
			setVoicePreview(text);
		}
	});
	const hasClearableContent = messages.length > 0 || input.trim().length > 0 || pendingImages.length > 0 || voice.isListening || voicePreview.trim().length > 0;
	useEffect(() => {
		const handlePrefill = (event) => {
			const detail = readChatPrefillDetail(event);
			if (!detail) return;
			if (voice.isListening) {
				voice.stopListening();
				setVoicePreview("");
			}
			setInput(detail.text ?? "");
			window.requestAnimationFrame(() => {
				composerRef.current?.focus();
				if (detail.select) composerRef.current?.select();
			});
		};
		window.addEventListener(CHAT_PREFILL_EVENT, handlePrefill);
		return () => {
			window.removeEventListener(CHAT_PREFILL_EVENT, handlePrefill);
		};
	}, [voice.isListening, voice.stopListening]);
	const handleInputChange = useCallback((value) => {
		if (voice.isListening) {
			voice.stopListening();
			setVoicePreview("");
		}
		setInput(value);
	}, [voice.isListening, voice.stopListening]);
	const handleKeyDown = useCallback((event) => {
		if (sending) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
	}, [handleSend, sending]);
	const handleClearConversation = useCallback(async () => {
		if (conversationAdapter?.allowClear === false) return;
		if (clearing || !conversation && !hasClearableContent) return;
		abortRef.current?.abort();
		if (voice.isListening) voice.stopListening();
		setClearing(true);
		setLoadError(null);
		try {
			setConversation(await resetPageScopedConversation({
				scope,
				title,
				pageId
			}));
			setMessages([]);
			setInput("");
			setPendingImages([]);
			setAttachmentError(null);
			setImageDragOver(false);
			setVoicePreview("");
			setSending(false);
			setFirstTokenReceived(false);
			setLoadError(null);
			window.requestAnimationFrame(() => {
				composerRef.current?.focus();
			});
		} catch (cause) {
			setLoadError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : "Failed to clear page chat.");
		} finally {
			setClearing(false);
		}
	}, [
		clearing,
		conversation,
		conversationAdapter,
		hasClearableContent,
		pageId,
		scope,
		title,
		voice.isListening,
		voice.stopListening
	]);
	const showIntro = messages.length === 0 && !sending && !persistentIntro;
	const showClearButton = conversationAdapter?.allowClear !== false;
	const introCard = (0, import_jsx_runtime.jsxs)("div", {
		"data-testid": `page-scoped-chat-intro-${scope}`,
		className: "rounded-2xl bg-card/50 p-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted",
				children: [(0, import_jsx_runtime.jsx)(Sparkles, { className: "h-3.5 w-3.5 text-accent" }), introTitle]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-sm leading-relaxed text-txt",
				children: introBody
			}),
			introActions ? (0, import_jsx_runtime.jsx)("div", {
				className: "mt-3 flex flex-wrap gap-2",
				children: introActions
			}) : null
		]
	});
	const composerT = useCallback((key, options) => {
		const fallback = typeof options?.defaultValue === "string" ? options.defaultValue : key;
		switch (key) {
			case "aria.attachImage":
			case "chatview.AttachImage": return "Add attachment";
			case "chat.agentStarting": return "Agent starting";
			case "chat.inputPlaceholder":
			case "chat.inputPlaceholderNarrow":
			case "common.message": return placeholder;
			case "chat.listening": return "Listening…";
			case "chat.micTitleIdleEnhanced":
			case "chat.micTitleIdleStandard": return "Start voice input";
			case "chat.releaseToSend": return "Release to send";
			case "chat.send":
			case "common.send": return "Send";
			case "chat.stopGeneration": return "Stop";
			case "chat.stopListening": return "Stop voice input";
			case "chat.stopSpeaking": return "Stop";
			case "chat.voiceInput": return "Voice input";
			default: return fallback;
		}
	}, [placeholder]);
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": `page-scoped-chat-${scope}`,
		"data-page-scope": scope,
		className: `flex min-h-0 flex-1 flex-col bg-bg transition-shadow ${imageDragOver ? "ring-1 ring-inset ring-accent/50" : ""} ${className ?? ""}`,
		"aria-label": copy.title,
		onDragLeave: () => setImageDragOver(false),
		onDragOver: (event) => {
			event.preventDefault();
			setImageDragOver(true);
		},
		onDrop: handleImageDrop,
		children: [
			persistentIntro ? (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 pt-3",
				children: introCard
			}) : null,
			(0, import_jsx_runtime.jsxs)("div", {
				ref: scrollRef,
				role: "log",
				"aria-live": "polite",
				"aria-atomic": "false",
				className: "flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3",
				children: [
					loadError ? (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger",
						children: loadError
					}) : null,
					showIntro ? introCard : null,
					messages.map((message) => (0, import_jsx_runtime.jsxs)("article", {
						className: `rounded-lg px-3 py-2 text-sm leading-relaxed ${message.role === "user" ? "ml-8 self-end bg-accent/10 text-txt" : "mr-8 bg-bg/40 text-txt"}`,
						children: [
							(0, import_jsx_runtime.jsx)("div", {
								className: "mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted",
								children: message.role === "user" ? "You" : "Eliza"
							}),
							message.images?.length ? (0, import_jsx_runtime.jsx)("div", {
								className: "mb-2 flex flex-wrap gap-2",
								children: message.images.map((image) => (0, import_jsx_runtime.jsx)("img", {
									src: `data:${image.mimeType};base64,${image.data}`,
									alt: image.name,
									className: "h-16 w-16 rounded-md border border-border/40 object-cover"
								}, `${image.name}:${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`))
							}) : null,
							message.text ? (0, import_jsx_runtime.jsx)("div", {
								className: "whitespace-pre-wrap",
								children: message.text
							}) : message.images?.length ? (0, import_jsx_runtime.jsx)("div", {
								className: "text-muted",
								children: message.images.length === 1 ? "Attached image" : `Attached ${message.images.length} images`
							}) : null
						]
					}, message.id)),
					sending && !firstTokenReceived ? (0, import_jsx_runtime.jsxs)("div", {
						className: "mr-8 flex items-center gap-1.5 rounded-lg bg-bg/40 px-3 py-2",
						children: [(0, import_jsx_runtime.jsx)(Spinner, {
							size: 12,
							className: "text-accent/70"
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "text-[11px] text-muted",
							children: "Thinking…"
						})]
					}) : null
				]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "px-2 py-1.5",
				children: [
					(0, import_jsx_runtime.jsx)("input", {
						ref: fileInputRef,
						type: "file",
						accept: "image/*",
						multiple: true,
						className: "hidden",
						onChange: handleFileInputChange
					}),
					attachmentError ? (0, import_jsx_runtime.jsx)("div", {
						className: "pb-1 text-[11px] text-danger",
						children: attachmentError
					}) : null,
					(0, import_jsx_runtime.jsx)(ChatAttachmentStrip, {
						items: pendingImages.map((image, imageIndex) => ({
							alt: image.name,
							id: String(imageIndex),
							name: image.name,
							src: `data:${image.mimeType};base64,${image.data}`
						})),
						onRemove: (_id, index) => removeImage(index)
					}),
					(0, import_jsx_runtime.jsx)("div", {
						"data-testid": `page-scoped-chat-composer-${scope}`,
						children: (0, import_jsx_runtime.jsx)(ChatComposer, {
							variant: "default",
							layout: "inline",
							textareaRef: composerRef,
							textareaAriaLabel: copy.title,
							chatInput: input,
							chatPendingImagesCount: pendingImages.length,
							isComposerLocked: disabled || sending,
							isAgentStarting: false,
							chatSending: sending,
							voice: {
								supported: voice.supported,
								isListening: voice.isListening,
								captureMode: voice.captureMode,
								interimTranscript: voicePreview,
								isSpeaking: voice.isSpeaking,
								assistantTtsQuality: voice.assistantTtsQuality,
								toggleListening: voice.toggleListening,
								startListening: voice.startListening,
								stopListening: voice.stopListening
							},
							agentVoiceEnabled: false,
							showAgentVoiceToggle: false,
							t: composerT,
							placeholder,
							onAttachImage: () => fileInputRef.current?.click(),
							onChatInputChange: handleInputChange,
							onKeyDown: handleKeyDown,
							onSend: () => void handleSend(),
							onStop: handleStop,
							onStopSpeaking: () => {},
							onToggleAgentVoice: () => {}
						})
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1 flex items-center justify-between gap-2 px-1",
						children: [showClearButton ? (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							"data-testid": `page-scoped-chat-clear-${scope}`,
							className: "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-txt disabled:cursor-not-allowed disabled:opacity-40",
							onClick: () => void handleClearConversation(),
							disabled: clearing || !conversation && !hasClearableContent,
							"aria-label": clearing ? "Clearing page chat" : "Clear page chat",
							children: [clearing ? (0, import_jsx_runtime.jsx)(Spinner, {
								size: 10,
								className: "text-muted"
							}) : (0, import_jsx_runtime.jsx)(RotateCcw, { className: "h-3 w-3" }), (0, import_jsx_runtime.jsx)("span", { children: clearing ? "Clearing…" : "Clear" })]
						}) : (0, import_jsx_runtime.jsx)("div", {}), footerActions ? (0, import_jsx_runtime.jsx)("div", {
							className: "flex items-center gap-1",
							children: footerActions
						}) : null]
					})
				]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/workspace/AppWorkspaceChrome.js
const APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY = "app-workspace-chrome:chat-collapsed";
const APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY = "app-workspace-chrome:chat-width";
const CHAT_DEFAULT_WIDTH = 384;
const CHAT_MIN_WIDTH = 240;
const CHAT_MAX_WIDTH = 640;
const WORKSPACE_MOBILE_MEDIA_QUERY = "(max-width: 819px)";
const AppWorkspaceChatChromeContext = createContext(null);
function useAppWorkspaceChatChrome() {
	return useContext(AppWorkspaceChatChromeContext);
}
function AppWorkspaceChatCollapseButton({ testId = "app-workspace-chat-collapse" }) {
	const chatChrome = useAppWorkspaceChatChrome();
	if (!chatChrome) return null;
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		"data-testid": testId,
		className: "inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
		"aria-label": "Collapse chat",
		onClick: () => chatChrome.collapseChat(),
		children: (0, import_jsx_runtime.jsx)(PanelRightClose, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		})
	});
}
function AppWorkspaceChatDockToggleButton({ collapsed, testId }) {
	const chatChrome = useAppWorkspaceChatChrome();
	if (!chatChrome) return null;
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		"data-testid": testId,
		className: "fixed bottom-2 right-2 z-40 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
		"aria-label": collapsed ? "Open page chat" : "Collapse chat",
		onClick: () => collapsed ? chatChrome.openChat() : chatChrome.collapseChat(),
		children: collapsed ? (0, import_jsx_runtime.jsx)(PanelRightOpen, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		}) : (0, import_jsx_runtime.jsx)(PanelRightClose, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		})
	});
}
function MobileWorkspacePaneSwitcher({ chatAvailable, chatOpen, sidebar, onChat, onMain, onSidebar }) {
	const sidebarOpen = sidebar?.open ?? false;
	const mainOpen = !sidebarOpen && (!chatAvailable || !chatOpen);
	const baseButtonClassName = "inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/40 bg-card/55 text-muted shadow-sm transition-colors hover:text-txt";
	const activeButtonClassName = "border-accent/70 bg-accent text-accent-fg hover:text-accent-fg";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border/35 bg-bg/92 px-2 py-1.5",
		"data-testid": "app-workspace-mobile-pane-switcher",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex min-w-0 justify-start",
				children: sidebar ? (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-label": "Show left sidebar",
					"aria-current": sidebarOpen ? "page" : void 0,
					title: "Show left sidebar",
					"data-testid": "app-workspace-mobile-pane-left",
					onClick: onSidebar,
					className: `${baseButtonClassName} ${sidebarOpen ? activeButtonClassName : ""}`,
					children: (0, import_jsx_runtime.jsx)(PanelLeftOpen, {
						className: "h-4 w-4",
						"aria-hidden": true
					})
				}) : (0, import_jsx_runtime.jsx)("span", {
					className: "h-9 w-9",
					"aria-hidden": true
				})
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex min-w-0 justify-center",
				children: (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-label": "Show content",
					"aria-current": mainOpen ? "page" : void 0,
					title: "Show content",
					"data-testid": "app-workspace-mobile-pane-main",
					onClick: onMain,
					className: `${baseButtonClassName} ${mainOpen ? activeButtonClassName : ""}`,
					children: (0, import_jsx_runtime.jsx)(LayoutDashboard, {
						className: "h-4 w-4",
						"aria-hidden": true
					})
				})
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex min-w-0 justify-end",
				children: chatAvailable ? (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-label": "Show page chat",
					"aria-current": chatOpen ? "page" : void 0,
					title: "Show page chat",
					"data-testid": "app-workspace-mobile-pane-chat",
					onClick: onChat,
					className: `${baseButtonClassName} ${chatOpen ? activeButtonClassName : ""}`,
					children: (0, import_jsx_runtime.jsx)(PanelRightOpen, {
						className: "h-4 w-4",
						"aria-hidden": true
					})
				}) : (0, import_jsx_runtime.jsx)("span", {
					className: "h-9 w-9",
					"aria-hidden": true
				})
			})
		]
	});
}
function clampWidth(value) {
	return Math.min(Math.max(value, CHAT_MIN_WIDTH), CHAT_MAX_WIDTH);
}
function readStoredCollapsed(defaultValue) {
	if (typeof window === "undefined") return defaultValue;
	const stored = window.localStorage.getItem(APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY);
	if (stored === null) return defaultValue;
	return stored === "true";
}
function readStoredWidth() {
	if (typeof window === "undefined") return CHAT_DEFAULT_WIDTH;
	try {
		const raw = window.localStorage.getItem(APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY);
		const parsed = raw ? Number.parseInt(raw, 10) : NaN;
		if (Number.isFinite(parsed)) return clampWidth(parsed);
	} catch {}
	return CHAT_DEFAULT_WIDTH;
}
/** Pure-layout chrome: main pane + collapsible right-side chat sidebar. */
function AppWorkspaceChrome({ nav, main, chat, chatScope, pageScopedChatPaneProps, chatCollapsed: chatCollapsedProp, onToggleChat, chatDefaultCollapsed = false, hideCollapseButton = false, chatDisabled = false, testId = "app-workspace-chrome" }) {
	const isControlled = chatCollapsedProp !== void 0;
	const isMobileViewport = useMediaQuery(WORKSPACE_MOBILE_MEDIA_QUERY);
	const [mobileChatOpen, setMobileChatOpen] = useState(false);
	const [mobileSidebarControl, setMobileSidebarControl] = useState(null);
	const [internalCollapsed, setInternalCollapsed] = useState(() => isControlled ? chatCollapsedProp ?? false : readStoredCollapsed(chatDefaultCollapsed));
	const prevIsControlled = useRef(isControlled);
	useEffect(() => {
		if (!prevIsControlled.current && isControlled) setInternalCollapsed(chatCollapsedProp ?? false);
		prevIsControlled.current = isControlled;
	}, [isControlled, chatCollapsedProp]);
	const collapsed = isControlled ? chatCollapsedProp ?? false : internalCollapsed;
	const effectiveCollapsed = chatDisabled ? true : isControlled ? collapsed : isMobileViewport ? !mobileChatOpen : collapsed;
	const handleToggle = useCallback((next) => {
		if (isMobileViewport) {
			mobileSidebarControl?.setOpen(false);
			if (isControlled) {
				onToggleChat?.(next);
				return;
			}
			setMobileChatOpen(chatDisabled ? false : !next);
			return;
		}
		if (isControlled) onToggleChat?.(next);
		else {
			setInternalCollapsed(next);
			try {
				window.localStorage.setItem(APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY, String(next));
			} catch {}
		}
	}, [
		chatDisabled,
		isControlled,
		isMobileViewport,
		mobileSidebarControl,
		onToggleChat
	]);
	const registerMobileSidebar = useCallback((control) => {
		setMobileSidebarControl(control);
		return () => {
			setMobileSidebarControl((current) => current?.id === control.id ? null : current);
		};
	}, []);
	const mobileSidebarControlsValue = useMemo(() => ({ register: registerMobileSidebar }), [registerMobileSidebar]);
	const handleOpenMobileSidebar = useCallback(() => {
		if (!mobileSidebarControl) return;
		setMobileChatOpen(false);
		mobileSidebarControl.setOpen(true);
	}, [mobileSidebarControl]);
	const handleOpenMobileMain = useCallback(() => {
		mobileSidebarControl?.setOpen(false);
		handleToggle(true);
	}, [handleToggle, mobileSidebarControl]);
	useEffect(() => {
		if (!isMobileViewport) setMobileChatOpen(false);
	}, [isMobileViewport]);
	const [chatWidth, setChatWidth] = useState(readStoredWidth);
	const applyChatWidth = useCallback((next) => {
		setChatWidth(next);
		try {
			window.localStorage.setItem(APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY, String(next));
		} catch {}
	}, []);
	const collapseThreshold = Math.max(CHAT_MIN_WIDTH - 40, 80);
	const handleResizePointerDown = useCallback((event) => {
		if (effectiveCollapsed || isMobileViewport) return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = chatWidth;
		const target = event.currentTarget;
		try {
			target.setPointerCapture(event.pointerId);
		} catch {}
		const onMove = (ev) => {
			const nextRaw = startWidth - (ev.clientX - startX);
			if (nextRaw < collapseThreshold) {
				handleToggle(true);
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				return;
			}
			applyChatWidth(clampWidth(nextRaw));
		};
		const onUp = () => {
			try {
				target.releasePointerCapture(event.pointerId);
			} catch {}
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [
		applyChatWidth,
		chatWidth,
		collapseThreshold,
		effectiveCollapsed,
		handleToggle,
		isMobileViewport
	]);
	const chatChromeContextValue = useMemo(() => ({
		collapseChat: () => handleToggle(true),
		openChat: () => handleToggle(false),
		isChatOpen: !effectiveCollapsed
	}), [effectiveCollapsed, handleToggle]);
	const chatContent = chat ?? (chatScope ? (0, import_jsx_runtime.jsx)(PageScopedChatPane, {
		...pageScopedChatPaneProps,
		scope: chatScope
	}) : (0, import_jsx_runtime.jsx)(ChatView, { variant: "default" }));
	return (0, import_jsx_runtime.jsx)(WorkspaceMobileSidebarControlsContext.Provider, {
		value: mobileSidebarControlsValue,
		children: (0, import_jsx_runtime.jsx)(AppWorkspaceChatChromeContext.Provider, {
			value: chatChromeContextValue,
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: `flex min-h-0 min-w-0 w-full flex-1 bg-bg pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))] ${isMobileViewport ? "flex-col" : ""}`,
				"data-testid": testId,
				children: [
					isMobileViewport && (!chatDisabled || mobileSidebarControl !== null) ? (0, import_jsx_runtime.jsx)(MobileWorkspacePaneSwitcher, {
						chatAvailable: !chatDisabled,
						chatOpen: !effectiveCollapsed,
						sidebar: mobileSidebarControl,
						onChat: () => handleToggle(false),
						onMain: handleOpenMobileMain,
						onSidebar: handleOpenMobileSidebar
					}) : null,
					(0, import_jsx_runtime.jsxs)("div", {
						className: `relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${isMobileViewport && !effectiveCollapsed ? "hidden" : "flex"}`,
						children: [nav, (0, import_jsx_runtime.jsx)("div", {
							className: "relative flex min-h-0 flex-1 flex-col overflow-hidden",
							children: main
						})]
					}),
					chatDisabled ? null : effectiveCollapsed ? (0, import_jsx_runtime.jsx)("aside", {
						className: "w-0 min-w-0 shrink-0",
						"data-testid": `${testId}-chat-sidebar`,
						"data-collapsed": true,
						children: !isMobileViewport ? (0, import_jsx_runtime.jsx)(AppWorkspaceChatDockToggleButton, {
							collapsed: true,
							testId: `${testId}-chat-expand`
						}) : null
					}) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
						isMobileViewport ? (0, import_jsx_runtime.jsx)("aside", {
							className: "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-bg",
							"data-testid": `${testId}-chat-sidebar`,
							children: (0, import_jsx_runtime.jsx)("div", {
								className: "flex min-h-0 flex-1 flex-col overflow-hidden",
								children: chatContent
							})
						}) : null,
						!isMobileViewport ? (0, import_jsx_runtime.jsxs)("aside", {
							className: "relative flex shrink-0 flex-col overflow-hidden bg-bg",
							style: {
								width: `${chatWidth}px`,
								minWidth: `${chatWidth}px`
							},
							"data-testid": `${testId}-chat-sidebar`,
							children: [(0, import_jsx_runtime.jsx)("hr", {
								"aria-label": "Resize chat",
								"aria-orientation": "vertical",
								"aria-valuemin": 0,
								"aria-valuemax": 100,
								"aria-valuenow": 50,
								tabIndex: 0,
								"data-testid": `${testId}-chat-resize-handle`,
								onPointerDown: handleResizePointerDown,
								className: "absolute inset-y-0 left-0 z-20 m-0 h-full w-3 -translate-x-1/2 cursor-col-resize touch-none select-none border-0 bg-transparent transition-colors hover:bg-accent/20"
							}), (0, import_jsx_runtime.jsx)("div", {
								className: "flex min-h-0 flex-1 flex-col overflow-hidden",
								children: chatContent
							})]
						}) : null,
						!isMobileViewport && !hideCollapseButton ? (0, import_jsx_runtime.jsx)(AppWorkspaceChatDockToggleButton, {
							collapsed: false,
							testId: `${testId}-chat-collapse`
						}) : null
					] })
				]
			})
		})
	});
}

//#endregion
export { sanitizeLinkHref as C, CodingAgentTasksPanel as D, CodingAgentSettingsSection as E, PtyConsoleBase as O, runValidation as S, CodingAgentControlChip as T, tryParsePatch as _, useAppWorkspaceChatChrome as a, evaluateUiVisibility as b, ChatView as c, MessageContent as d, compilePatches as f, normalizePluginId as g, normalizeDisplayText as h, AppWorkspaceChrome as i, registerTaskCoordinatorSlots as k, TerminalChannelPanel as l, looksLikePatch as m, APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY as n, PageScopedChatPane as o, findPatchRegions as p, AppWorkspaceChatCollapseButton as r, getBrowserPageScopeCopy as s, APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY as t, __resetCompanionSpeechMemoryForTests as u, ChoiceWidget as v, AgentActivityBox as w, getSupportedComponents as x, UiRenderer as y };