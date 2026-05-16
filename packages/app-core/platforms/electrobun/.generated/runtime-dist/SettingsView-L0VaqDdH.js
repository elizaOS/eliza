import { D as require_jsx_runtime, S as invokeDesktopBridgeRequest, T as subscribeDesktopBridgeEvent, k as __exportAll, n as isElectrobunRuntime } from "./electrobun-runtime-zXJ9acDW.js";
import { N as getBootConfig, O as getElizaApiToken, d as client, n as useApp } from "./useApp-Dh-r7aR7.js";
import { B as getStoredSubscriptionProvider, Cr as isDesktopPlatform, Er as isNative, Fn as fetchWithCsrf, Ft as loadPersistedActivePackUrl, G as PREMADE_VOICES, H as buildWalletRpcUpdateRequest, Ia as useBootConfig, J as sanitizeApiKey, Jr as openExternalUrl, Na as appNameInterpolationVars, On as applyThemeToDocument, Or as isWebPlatform, Pa as useBranding, R as SUBSCRIPTION_PROVIDER_SELECTIONS, U as resolveInitialWalletRpcSelections, V as isSubscriptionProviderSelectionId, W as EDGE_BACKUP_VOICES, Xi as VOICE_CONFIG_UPDATED_EVENT, Yr as preOpenWindow, dn as savePersistedActivePackUrl, lt as replaceNameTokens, n as consumePendingFocusProvider, p as hasRequiredOnboardingPermissions, q as hasConfiguredApiKey, qr as navigatePreOpenedWindow, t as SETTINGS_FOCUS_CONNECTOR_EVENT, ta as dispatchWindowEvent, ua as resolveApiUrl, ui as openDesktopSurfaceWindow, wr as isElizaOS, z as getOnboardingProviderOption$1 } from "./state-BC9WO-N8.js";
import { t as AppPageSidebar } from "./AppPageSidebar-myyOdXbd.js";
import { _ as resolveCloudAccountIdDisplay, c as getBillingAutoTopUp, d as normalizeBillingSettings, f as normalizeBillingSummary, g as resolveCheckoutUrl, h as readString, i as buildAutoTopUpFormState, l as getBillingLimits, m as readNumber, n as ELIZA_CLOUD_WEB_URL, o as consumeManagedDiscordCallbackUrl, p as readBoolean, r as autoTopUpFormReducer, s as consumeManagedGithubCallbackUrl, t as BILLING_PRESET_AMOUNTS, u as isRecord$1 } from "./cloud-dashboard-utils-Dedro-JF.js";
import { ConfigRenderer, autoLabel, defaultRegistry, useConfigValidation } from "./index.js";
import { BUILTIN_THEMES, CONTENT_PACK_MANIFEST_FILENAME, WALLET_RPC_PROVIDER_OPTIONS, asRecord, buildElizaCloudServiceRoute, normalizeOnboardingProviderId, normalizeServiceRoutingConfig, resolveServiceRoutingInConfig, validateContentPackManifest } from "@elizaos/shared";
import { Badge, Button, Checkbox, ContentLayout, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Field, FieldDescription, FieldLabel, Input, Label, PageLayout, PagePanel, SaveFooter, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SidebarContent, SidebarPanel, SidebarScrollRegion, Spinner, StatusBadge, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, ThemedSelect, TooltipHint, cn, useLinkedSidebarSelection, useTimeout } from "@elizaos/ui";
import { AlertCircle, AlertTriangle, Archive, ArrowLeft, ArrowRight, Bot, Brain, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Circle, Cloud, Copy, Cpu, CreditCard, Download, ExternalLink, Eye, EyeOff, FolderOpen, Gauge, HardDrive, KeyRound, Laptop, LayoutGrid, Loader2, LogIn, LogOut, Mic, Monitor, Moon, MousePointer2, Palette, Pencil, Play, Plus, RefreshCw, RotateCcw, RotateCw, Server, Settings, Shield, ShieldBan, ShieldCheck, SlidersHorizontal, Smartphone, Square, Sun, Terminal, Trash2, Upload, User, Volume2, VolumeX, Wallet, Zap } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import os from "node:os";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth-client.js
/**
* Typed client for P1 session auth endpoints.
*
* All state-changing calls go through `fetchWithCsrf` so the CSRF header is
* attached automatically. GET requests use plain `fetch` with
* `credentials: "include"`.
*
* This module is UI-only. It deliberately does NOT import ElizaClient so it
* can be used in auth-gated components before the main client is initialised.
*/
/**
* Resolves the base URL for auth calls. Reads from the same source as the
* main ElizaClient so they stay in sync.
*/
function authBase() {
	if (typeof window === "undefined") return "";
	const apiBase = getBootConfig().apiBase;
	return apiBase ? apiBase.replace(/\/$/, "") : window.location.origin;
}
/**
* POST /api/auth/setup — first-run owner identity creation.
* Returns 409 if an owner identity already exists.
*/
async function authSetup(params) {
	let res;
	try {
		res = await fetchWithCsrf(`${authBase()}/api/auth/setup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params)
		});
	} catch (err) {
		return {
			ok: false,
			status: 500,
			reason: "server_error",
			message: err instanceof Error ? err.message : "Network error"
		};
	}
	if (res.ok) return {
		ok: true,
		...await res.json()
	};
	const body = await res.json().catch(() => ({}));
	const reason = body.reason ?? body.error ?? "";
	if (res.status === 409) return {
		ok: false,
		status: 409,
		reason: "already_initialized",
		message: "An owner account already exists."
	};
	if (res.status === 429) return {
		ok: false,
		status: 429,
		reason: "rate_limited",
		message: "Too many attempts — wait a moment and try again."
	};
	if (res.status === 400 && reason === "weak_password") return {
		ok: false,
		status: 400,
		reason: "weak_password",
		message: "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols."
	};
	if (res.status === 400) return {
		ok: false,
		status: 400,
		reason: "invalid_display_name",
		message: "Display name must be 1–64 characters (letters, numbers, spaces, _ . - @)."
	};
	return {
		ok: false,
		status: 500,
		reason: "server_error",
		message: `Unexpected error (${res.status})`
	};
}
/**
* POST /api/auth/login/password — password-based login.
*/
async function authLoginPassword(params) {
	let res;
	try {
		res = await fetchWithCsrf(`${authBase()}/api/auth/login/password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params)
		});
	} catch (err) {
		return {
			ok: false,
			status: 500,
			reason: "server_error",
			message: err instanceof Error ? err.message : "Network error"
		};
	}
	if (res.ok) return {
		ok: true,
		...await res.json()
	};
	if (res.status === 429) return {
		ok: false,
		status: 429,
		reason: "rate_limited",
		message: "Too many attempts — wait a moment and try again."
	};
	return {
		ok: false,
		status: res.status === 401 ? 401 : 500,
		reason: res.status === 401 || res.status === 400 ? "invalid_credentials" : "server_error",
		message: res.status === 401 || res.status === 400 ? "Invalid display name or password." : `Unexpected error (${res.status})`
	};
}
/**
* GET /api/auth/me — returns the current identity + session, or 401.
*
* Fail closed: network errors are treated as 503 so the startup shell can
* show a backend failure instead of a misleading credential prompt.
*/
async function authMe() {
	let res;
	try {
		res = await fetchWithCsrf(`${authBase()}/api/auth/me`);
	} catch {
		return {
			ok: false,
			status: 503
		};
	}
	if (res.ok) {
		const body = await res.json();
		return {
			ok: true,
			identity: body.identity,
			session: body.session,
			access: body.access ?? {
				mode: "session",
				passwordConfigured: true,
				ownerConfigured: true
			}
		};
	}
	if (res.status === 401) {
		const body = await res.json().catch(() => ({}));
		return {
			ok: false,
			status: 401,
			reason: body.reason === "remote_password_not_configured" ? "remote_password_not_configured" : body.reason === "remote_auth_required" ? "remote_auth_required" : "server_error",
			access: body.access
		};
	}
	return {
		ok: false,
		status: 503
	};
}
/**
* GET /api/auth/sessions — lists active sessions for the current identity.
*/
async function authListSessions() {
	let res;
	try {
		res = await fetch(`${authBase()}/api/auth/sessions`, { credentials: "include" });
	} catch {
		return {
			ok: false,
			status: 401
		};
	}
	if (res.ok) return {
		ok: true,
		sessions: (await res.json()).sessions
	};
	return {
		ok: false,
		status: res.status === 503 ? 503 : 401
	};
}
/**
* POST /api/auth/sessions/:id/revoke — revokes one session.
*/
async function authRevokeSession(sessionId) {
	let res;
	try {
		res = await fetchWithCsrf(`${authBase()}/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });
	} catch {
		return {
			ok: false,
			status: 500
		};
	}
	if (res.ok) return { ok: true };
	if (res.status === 404) return {
		ok: false,
		status: 404
	};
	if (res.status === 401) return {
		ok: false,
		status: 401
	};
	return {
		ok: false,
		status: 500
	};
}
async function authChangePassword(params) {
	let res;
	try {
		res = await fetchWithCsrf(`${authBase()}/api/auth/password/change`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params)
		});
	} catch (err) {
		return {
			ok: false,
			status: 500,
			reason: "server_error",
			message: err instanceof Error ? err.message : "Network error"
		};
	}
	if (res.ok) return { ok: true };
	const body = await res.json().catch(() => ({}));
	const reason = body.reason ?? body.error ?? "";
	if (res.status === 400 && reason === "weak_password") return {
		ok: false,
		status: 400,
		reason: "weak_password",
		message: "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols."
	};
	if (res.status === 401) return {
		ok: false,
		status: 401,
		reason: "invalid_credentials",
		message: "Current password is incorrect."
	};
	if (res.status === 404) return {
		ok: false,
		status: 404,
		reason: "owner_not_found",
		message: "No owner account exists yet."
	};
	if (res.status === 429) return {
		ok: false,
		status: 429,
		reason: "rate_limited",
		message: "Too many attempts — wait a moment and try again."
	};
	return {
		ok: false,
		status: 500,
		reason: "server_error",
		message: `Unexpected error (${res.status})`
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useSecretsManagerModal.js
const VAULT_TABS = [
	"overview",
	"secrets",
	"logins",
	"routing"
];
const EVENT_NAME = "eliza:secrets-manager-toggle";
function dispatchSecretsManagerOpen(options = {}) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: {
		action: "open",
		...options
	} }));
}
/**
* Subscribe to the modal's open state. Useful for the modal itself
* (it must mount its content based on this flag) and for the inline
* launcher row (so it can optionally show "Manage…" disabled while
* the modal is open).
*
* `initialTab` / `focusKey` / `focusProfileId` carry the parameters of
* the most recent open dispatch. The modal consumes them on mount and
* is expected to call `clearFocus()` once the focus has been applied so
* subsequent opens (e.g. via the keyboard shortcut) start fresh.
*/
function useSecretsManagerModalState() {
	const [isOpen, setIsOpen] = useState(false);
	const [initialTab, setInitialTab] = useState(null);
	const [focusKey, setFocusKey] = useState(null);
	const [focusProfileId, setFocusProfileId] = useState(null);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onToggle = (event) => {
			const detail = event.detail;
			if (!detail) return;
			if (detail.action === "open") {
				setIsOpen(true);
				setInitialTab(detail.tab ?? null);
				setFocusKey(detail.focusKey ?? null);
				setFocusProfileId(detail.focusProfileId ?? null);
				return;
			}
			if (detail.action === "close") {
				setIsOpen(false);
				return;
			}
			setIsOpen((prev) => {
				if (!prev && detail.tab) setInitialTab(detail.tab);
				return !prev;
			});
		};
		window.addEventListener(EVENT_NAME, onToggle);
		return () => {
			window.removeEventListener(EVENT_NAME, onToggle);
		};
	}, []);
	return {
		isOpen,
		initialTab,
		focusKey,
		focusProfileId,
		open: useCallback(() => setIsOpen(true), []),
		close: useCallback(() => setIsOpen(false), []),
		toggle: useCallback(() => setIsOpen((prev) => !prev), []),
		setOpen: useCallback((next) => setIsOpen(next), []),
		openOnTab: useCallback((options) => {
			setIsOpen(true);
			setInitialTab(options.tab ?? null);
			setFocusKey(options.focusKey ?? null);
			setFocusProfileId(options.focusProfileId ?? null);
		}, []),
		clearFocus: useCallback(() => {
			setInitialTab(null);
			setFocusKey(null);
			setFocusProfileId(null);
		}, [])
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useSecretsManagerShortcut.js
/**
* Wires the keyboard / menu triggers for the Secrets Manager modal.
*
* Two trigger paths feed the same open action:
*
*   1. **Renderer-side keyboard chord** — caught by a `keydown`
*      listener on `document`. Handles every Eliza window.
*      Mac default: ⌘⌥⌃V (Command + Option + Control + V)
*      Win/Linux:   Ctrl + Alt + Shift + V
*
*   2. **Application menu accelerator** — Electrobun's bun-side menu
*      registers an item with the same accelerator. When the user
*      hits the chord, bun fires `application-menu-clicked` with
*      action `"open-secrets-manager"`, the bun handler turns that
*      into `sendToActiveRenderer("openSecretsManager", {})`, and
*      this hook subscribes to receive it. Both routes converge on
*      the same toggle dispatch.
*
* Mount this hook ONCE in the top-level App component alongside the
* `<SecretsManagerModalRoot />` mount.
*/
function useSecretsManagerShortcut() {
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onKeyDown = (event) => {
			if (event.repeat) return;
			if (!matchesShortcut(event)) return;
			event.preventDefault();
			event.stopPropagation();
			dispatchSecretsManagerOpen();
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, []);
	useEffect(() => {
		return subscribeDesktopBridgeEvent({
			rpcMessage: "openSecretsManager",
			ipcChannel: "desktop:openSecretsManager",
			listener: () => {
				dispatchSecretsManagerOpen();
			}
		});
	}, []);
}
/**
* Detects the Secrets-Manager shortcut. Per-platform mapping:
*   - macOS (`navigator.platform.includes("Mac")`):
*       metaKey (⌘) + altKey (⌥) + ctrlKey (⌃) + key === "v"
*   - Otherwise:
*       ctrlKey + altKey + shiftKey + key === "v"
*/
function matchesShortcut(event) {
	if (event.key.toLowerCase() !== "v" && event.code !== "KeyV") return false;
	if (typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)) return event.metaKey && event.altKey && event.ctrlKey && !event.shiftKey;
	return event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey;
}
/** Human-readable label for the shortcut, suitable for UI hints. */
function getShortcutLabel() {
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘⌥⌃V" : "Ctrl+Alt+Shift+V";
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/vault-tabs/LoginsTab.js
/**
* Logins tab — saved-logins list (in-house + 1Password + Bitwarden) with
* the in-house "Add login" form. Per-source rows; external rows are
* read-only links back to the password manager.
*
* Extracted from the original `SecretsManagerSection.tsx` `SavedLoginsPanel`.
*/
var import_jsx_runtime = require_jsx_runtime();
const SOURCE_LABEL = {
	"in-house": "Local",
	"1password": "1Password",
	bitwarden: "Bitwarden"
};
const SOURCE_PILL_CLASS = {
	"in-house": "border-accent/40 bg-accent/10 text-accent",
	"1password": "border-info/40 bg-info/10 text-info",
	bitwarden: "border-warn/40 bg-warn/10 text-warn"
};
function relativeAge(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const elapsed = Date.now() - ms;
	if (elapsed < 6e4) return "just now";
	const minutes = Math.floor(elapsed / 6e4);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}
function LoginsTab() {
	const [logins, setLogins] = useState(null);
	const [failures, setFailures] = useState([]);
	const [error, setError] = useState(null);
	const [showAdd, setShowAdd] = useState(false);
	const [addDomain, setAddDomain] = useState("");
	const [addUsername, setAddUsername] = useState("");
	const [addPassword, setAddPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [filter, setFilter] = useState("");
	const [autoallowMap, setAutoallowMap] = useState({});
	const loadAutoallowFor = useCallback(async (domains) => {
		const next = {};
		const unique = Array.from(new Set(domains.filter(Boolean)));
		const responses = await Promise.all(unique.map(async (d) => {
			const res = await fetch(`/api/secrets/logins/${encodeURIComponent(d)}/autoallow`);
			if (!res.ok) return [d, false];
			return [d, (await res.json())?.allowed === true];
		}));
		for (const [d, allowed] of responses) next[d] = allowed;
		setAutoallowMap(next);
	}, []);
	const load = useCallback(async () => {
		setError(null);
		setLogins(null);
		try {
			const res = await fetch("/api/secrets/logins");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			setLogins(json.logins);
			setFailures(json.failures ?? []);
			const domains = json.logins.map((l) => l.domain).filter((d) => typeof d === "string" && d.length > 0);
			try {
				await loadAutoallowFor(domains);
			} catch {
				setAutoallowMap({});
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "load failed");
			setLogins([]);
			setFailures([]);
		}
	}, [loadAutoallowFor]);
	const onToggleAutoallow = useCallback(async (domain, next) => {
		setAutoallowMap((prev) => ({
			...prev,
			[domain]: next
		}));
		const res = await fetch(`/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ allowed: next })
		});
		if (!res.ok) {
			setError(`HTTP ${res.status} (autoallow update failed)`);
			setAutoallowMap((prev) => ({
				...prev,
				[domain]: !next
			}));
		}
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	const onAdd = useCallback(async (event) => {
		event.preventDefault();
		if (!addDomain.trim() || !addUsername || !addPassword) return;
		setSubmitting(true);
		setError(null);
		const res = await fetch("/api/secrets/logins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				domain: addDomain.trim(),
				username: addUsername,
				password: addPassword
			})
		});
		setSubmitting(false);
		if (!res.ok) {
			setError(`HTTP ${res.status}`);
			return;
		}
		setAddDomain("");
		setAddUsername("");
		setAddPassword("");
		setShowAdd(false);
		await load();
	}, [
		addDomain,
		addUsername,
		addPassword,
		load
	]);
	const onDelete = useCallback(async (login) => {
		if (login.source !== "in-house") return;
		if (!window.confirm(`Delete saved login for ${login.domain ?? "—"} (${login.username})?`)) return;
		setError(null);
		const colon = login.identifier.indexOf(":");
		const domainPart = colon > 0 ? login.identifier.slice(0, colon) : "";
		const userPart = colon > 0 ? login.identifier.slice(colon + 1) : "";
		const path = `/api/secrets/logins/${encodeURIComponent(domainPart)}/${encodeURIComponent(userPart)}`;
		const res = await fetch(path, { method: "DELETE" });
		if (!res.ok) {
			setError(`HTTP ${res.status}`);
			return;
		}
		await load();
	}, [load]);
	const filtered = (logins ?? []).filter((l) => {
		if (filter.trim().length === 0) return true;
		const needle = filter.trim().toLowerCase();
		return l.title.toLowerCase().includes(needle) || l.username.toLowerCase().includes(needle) || (l.domain ?? "").toLowerCase().includes(needle);
	});
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": "saved-logins-panel",
		className: "space-y-2",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-medium text-txt",
						children: "Saved logins"
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Browser autofill from local vault, 1Password, and Bitwarden."
					})]
				}), (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 shrink-0 gap-1 rounded-md px-2",
					onClick: () => setShowAdd((v) => !v),
					children: [(0, import_jsx_runtime.jsx)(Plus, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), "Add login"]
				})]
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				"aria-live": "polite",
				className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger",
				children: error
			}),
			failures.length > 0 && (0, import_jsx_runtime.jsx)("div", {
				"aria-live": "polite",
				"data-testid": "saved-logins-failures",
				className: "space-y-1",
				children: failures.map((f) => (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-2xs text-warn",
					children: [
						SOURCE_LABEL[f.source],
						" failed to load: ",
						f.message
					]
				}, f.source))
			}),
			showAdd && (0, import_jsx_runtime.jsxs)("form", {
				onSubmit: onAdd,
				className: "space-y-2 rounded-md border border-border/50 bg-card/30 p-2",
				"data-testid": "saved-logins-add-form",
				children: [
					(0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Saved to local (encrypted) vault. To add to 1Password or Bitwarden, use that app directly."
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "grid grid-cols-1 gap-2 sm:grid-cols-2",
						children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
							className: "text-2xs text-muted",
							children: "Domain"
						}), (0, import_jsx_runtime.jsx)(Input, {
							value: addDomain,
							onChange: (e) => setAddDomain(e.target.value),
							placeholder: "github.com",
							className: "h-8 text-xs",
							autoComplete: "off",
							required: true
						})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
							className: "text-2xs text-muted",
							children: "Username / email"
						}), (0, import_jsx_runtime.jsx)(Input, {
							value: addUsername,
							onChange: (e) => setAddUsername(e.target.value),
							placeholder: "alice@example.com",
							className: "h-8 text-xs",
							autoComplete: "off",
							required: true
						})] })]
					}),
					(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
						className: "text-2xs text-muted",
						children: "Password"
					}), (0, import_jsx_runtime.jsx)(Input, {
						type: "password",
						value: addPassword,
						onChange: (e) => setAddPassword(e.target.value),
						className: "h-8 text-xs",
						autoComplete: "new-password",
						required: true
					})] }),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex justify-end gap-2 pt-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							className: "h-7 rounded-md px-3 text-xs",
							onClick: () => setShowAdd(false),
							disabled: submitting,
							children: "Cancel"
						}), (0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							variant: "default",
							size: "sm",
							className: "h-7 gap-1 rounded-md px-3 text-xs",
							disabled: submitting || !addDomain.trim() || !addUsername || !addPassword,
							children: submitting ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Loader2, {
								className: "h-3.5 w-3.5 animate-spin",
								"aria-hidden": true
							}), "Saving…"] }) : "Save"
						})]
					})
				]
			}),
			logins !== null && logins.length > 0 && (0, import_jsx_runtime.jsx)(Input, {
				value: filter,
				onChange: (e) => setFilter(e.target.value),
				placeholder: "Filter by title, user, or domain",
				className: "h-8 text-xs",
				autoComplete: "off",
				"data-testid": "saved-logins-filter"
			}),
			logins === null ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-1 py-3 text-xs text-muted",
				children: [(0, import_jsx_runtime.jsx)(Loader2, {
					className: "h-3.5 w-3.5 animate-spin",
					"aria-hidden": true
				}), " Loading…"]
			}) : logins.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
				"data-testid": "saved-logins-empty",
				className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
				children: "No saved logins yet. Add one here, or sign in to 1Password / Bitwarden on the Overview tab to surface their entries."
			}) : filtered.length === 0 ? (0, import_jsx_runtime.jsxs)("div", {
				"data-testid": "saved-logins-no-match",
				className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
				children: [
					"No logins match \"",
					filter,
					"\"."
				]
			}) : (0, import_jsx_runtime.jsx)("ul", {
				"data-testid": "saved-logins-list",
				className: "space-y-1 rounded-md border border-border/40 bg-card/30 p-1",
				children: filtered.map((login) => (0, import_jsx_runtime.jsxs)("li", {
					className: "flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg-muted/30",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: `shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${SOURCE_PILL_CLASS[login.source]}`,
							children: SOURCE_LABEL[login.source]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "min-w-0 flex-1",
							children: [(0, import_jsx_runtime.jsxs)("p", {
								className: "truncate text-xs font-medium text-txt",
								children: [login.title, login.domain && login.domain !== login.title ? (0, import_jsx_runtime.jsxs)("span", {
									className: "ml-1.5 text-muted",
									children: [
										"(",
										login.domain,
										")"
									]
								}) : null]
							}), (0, import_jsx_runtime.jsxs)("p", {
								className: "truncate text-2xs text-muted",
								children: [
									login.username || "—",
									" · ",
									relativeAge(login.updatedAt)
								]
							})]
						}),
						login.domain ? (0, import_jsx_runtime.jsx)(AgentAutoallowToggle, {
							domain: login.domain,
							allowed: autoallowMap[login.domain] === true,
							onChange: (next) => void onToggleAutoallow(login.domain ?? "", next)
						}) : null,
						login.source === "in-house" ? (0, import_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							size: "sm",
							className: "h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-danger",
							"aria-label": `Delete saved login for ${login.domain ?? login.username}`,
							onClick: () => void onDelete(login),
							children: (0, import_jsx_runtime.jsx)(Trash2, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						}) : (0, import_jsx_runtime.jsx)(ExternalRowAction, { login })
					]
				}, `${login.source}:${login.identifier}`))
			})
		]
	});
}
function AgentAutoallowToggle({ domain, allowed, onChange }) {
	const label = allowed ? `Agent autofill enabled for ${domain}. Click to disable.` : `Allow the agent to autofill ${domain} without prompting.`;
	return (0, import_jsx_runtime.jsx)(Button, {
		variant: "ghost",
		size: "sm",
		className: `h-7 w-7 shrink-0 rounded-md p-0 ${allowed ? "text-accent hover:text-accent" : "text-muted hover:text-txt"}`,
		"aria-label": label,
		title: label,
		onClick: () => onChange(!allowed),
		"data-testid": `agent-autoallow-toggle-${domain}`,
		"data-allowed": allowed ? "1" : "0",
		children: (0, import_jsx_runtime.jsx)(Bot, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		})
	});
}
function ExternalRowAction({ login }) {
	return (0, import_jsx_runtime.jsxs)("a", {
		href: login.source === "1password" ? `https://my.1password.com/vaults/all/allitems/${encodeURIComponent(login.identifier)}` : "https://vault.bitwarden.com/",
		target: "_blank",
		rel: "noopener noreferrer",
		className: "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/40 px-2 text-2xs text-muted hover:text-txt",
		"aria-label": `View in ${SOURCE_LABEL[login.source]}`,
		title: `View in ${SOURCE_LABEL[login.source]}`,
		children: [(0, import_jsx_runtime.jsx)(ExternalLink, {
			className: "h-3 w-3",
			"aria-hidden": true
		}), "View"]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/vault-tabs/OverviewTab.js
/**
* Overview tab — backends list, install / sign-in / sign-out, ordering,
* and the "Save preferences" action.
*
* Extracted from the original `SecretsManagerModal` body. The parent
* Vault modal owns data fetching and the save flow; this component
* only renders the rows + the editable preference state.
*/
const BACKEND_ORDER = [
	"in-house",
	"1password",
	"bitwarden",
	"protonpass"
];
function OverviewTab(props) {
	const { backends, preferences, installMethods, saving, savedAt, onPreferencesChange, onSave, onReload, onInstallComplete, onSigninComplete, onSignout } = props;
	const [installSheet, setInstallSheet] = useState(null);
	const [signinSheet, setSigninSheet] = useState(null);
	const isEnabled = useCallback((id) => preferences.enabled.includes(id) || id === "in-house", [preferences]);
	const setEnabled = useCallback((id, on) => {
		const next = new Set(preferences.enabled);
		if (on) next.add(id);
		else next.delete(id);
		const ordered = preferences.enabled.filter((b) => next.has(b));
		for (const id2 of next) if (!ordered.includes(id2)) ordered.push(id2);
		if (!ordered.includes("in-house")) ordered.push("in-house");
		onPreferencesChange({
			...preferences,
			enabled: ordered
		});
	}, [preferences, onPreferencesChange]);
	const moveUp = useCallback((id) => {
		const idx = preferences.enabled.indexOf(id);
		if (idx <= 0) return;
		const next = [...preferences.enabled];
		const swap = next[idx - 1];
		const cur = next[idx];
		if (!swap || !cur) return;
		next[idx - 1] = cur;
		next[idx] = swap;
		onPreferencesChange({
			...preferences,
			enabled: next
		});
	}, [preferences, onPreferencesChange]);
	const moveDown = useCallback((id) => {
		const idx = preferences.enabled.indexOf(id);
		if (idx < 0 || idx >= preferences.enabled.length - 1) return;
		const next = [...preferences.enabled];
		const swap = next[idx + 1];
		const cur = next[idx];
		if (!swap || !cur) return;
		next[idx + 1] = cur;
		next[idx] = swap;
		onPreferencesChange({
			...preferences,
			enabled: next
		});
	}, [preferences, onPreferencesChange]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between pb-1",
				children: [(0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs text-muted",
					children: "Sensitive values route to the first enabled backend."
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "h-7 rounded-md px-2",
					onClick: onReload,
					"aria-label": "Re-detect backends",
					title: "Re-detect backends",
					children: (0, import_jsx_runtime.jsx)(RefreshCw, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					})
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "space-y-1.5",
				children: orderedBackends(backends, preferences).map((backend) => (0, import_jsx_runtime.jsx)(BackendRow, {
					backend,
					enabled: isEnabled(backend.id),
					isPrimary: preferences.enabled[0] === backend.id,
					position: preferences.enabled.indexOf(backend.id),
					totalEnabled: preferences.enabled.length,
					methods: backend.id === "in-house" ? [] : installMethods[backend.id] ?? [],
					installSheetOpen: installSheet === backend.id,
					signinSheetOpen: signinSheet === backend.id,
					onToggle: (on) => setEnabled(backend.id, on),
					onMoveUp: () => moveUp(backend.id),
					onMoveDown: () => moveDown(backend.id),
					onOpenInstallSheet: () => setInstallSheet(backend.id),
					onOpenSigninSheet: () => setSigninSheet(backend.id),
					onCloseSheets: () => {
						setInstallSheet(null);
						setSigninSheet(null);
					},
					onInstallComplete: () => {
						setInstallSheet(null);
						onInstallComplete();
					},
					onSigninComplete: () => {
						setSigninSheet(null);
						onSigninComplete();
					},
					onSignout: () => onSignout(backend.id)
				}, backend.id))
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex items-center justify-end gap-2 border-t border-border/30 pt-2",
				children: (0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					className: "h-8 rounded-md font-semibold",
					onClick: onSave,
					disabled: saving,
					children: saving ? "Saving…" : savedAt !== null ? "Saved" : "Save preferences"
				})
			})
		]
	});
}
function orderedBackends(backends, preferences) {
	const enabledList = preferences.enabled.map((id) => backends.find((b) => b.id === id)).filter((b) => b !== void 0);
	const disabledList = backends.filter((b) => !preferences.enabled.includes(b.id));
	const sortedDisabled = BACKEND_ORDER.map((id) => disabledList.find((b) => b.id === id)).filter((b) => b !== void 0);
	return [...enabledList, ...sortedDisabled];
}
function BackendRow(props) {
	const { backend, enabled, isPrimary, position, totalEnabled, methods, installSheetOpen, signinSheetOpen, onToggle, onMoveUp, onMoveDown, onOpenInstallSheet, onOpenSigninSheet, onCloseSheets, onInstallComplete, onSigninComplete, onSignout } = props;
	const tone = backend.available ? backend.signedIn === false ? "warn" : "ok" : "muted";
	const status = backend.available ? backend.signedIn === false ? "Detected" : "Ready" : "Not detected";
	const lockedInHouse = backend.id === "in-house";
	const isInstallable = !lockedInHouse;
	const showInstallButton = isInstallable && !backend.available;
	const showSigninButton = isInstallable && backend.available && backend.signedIn === false;
	const showSignoutButton = isInstallable && backend.available && backend.signedIn === true;
	const installableId = backend.id;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `rounded-lg border bg-card/35 px-3 py-2.5 ${enabled ? "border-border" : "border-border/40 opacity-70"}`,
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-3",
				children: [
					(0, import_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: enabled,
						disabled: lockedInHouse,
						onChange: (e) => onToggle(e.target.checked),
						className: "h-4 w-4 cursor-pointer accent-accent disabled:cursor-not-allowed",
						"aria-label": `Enable ${backend.label}`
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0 flex-1",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2",
							children: [
								(0, import_jsx_runtime.jsx)("span", {
									className: "truncate text-sm font-medium text-txt",
									children: backend.label
								}),
								(0, import_jsx_runtime.jsx)(StatusPill, {
									tone,
									text: status
								}),
								backend.authMode === "desktop-app" && (0, import_jsx_runtime.jsx)("span", {
									"data-testid": `auth-mode-badge-${backend.id}`,
									className: "rounded-full border border-info/40 bg-info/10 px-1.5 py-0.5 text-2xs font-medium text-info",
									title: "Authenticated via 1Password desktop app",
									children: "via desktop app"
								}),
								isPrimary && enabled && (0, import_jsx_runtime.jsx)("span", {
									className: "rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
									children: "Primary"
								})
							]
						}), backend.detail && (0, import_jsx_runtime.jsx)("p", {
							className: "mt-0.5 truncate text-2xs text-muted",
							children: backend.detail
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex shrink-0 items-center gap-1",
						children: [
							showInstallButton && (0, import_jsx_runtime.jsxs)(Button, {
								variant: "outline",
								size: "sm",
								className: "h-7 gap-1 rounded-md px-2 text-xs",
								onClick: onOpenInstallSheet,
								"aria-label": `Install ${backend.label}`,
								children: [(0, import_jsx_runtime.jsx)(Download, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}), "Install"]
							}),
							showSigninButton && (0, import_jsx_runtime.jsxs)(Button, {
								variant: "outline",
								size: "sm",
								className: "h-7 gap-1 rounded-md px-2 text-xs",
								onClick: onOpenSigninSheet,
								"aria-label": `Sign in to ${backend.label}`,
								children: [(0, import_jsx_runtime.jsx)(LogIn, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}), "Sign in"]
							}),
							showSignoutButton && (0, import_jsx_runtime.jsxs)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-7 gap-1 rounded-md px-2 text-xs text-muted",
								onClick: onSignout,
								"aria-label": `Sign out of ${backend.label}`,
								title: "Sign out",
								children: [(0, import_jsx_runtime.jsx)(LogOut, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}), "Sign out"]
							}),
							enabled && backend.available && backend.signedIn !== false && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-7 w-7 rounded-md p-0",
								onClick: onMoveUp,
								disabled: position <= 0,
								title: "Move up",
								"aria-label": "Move up",
								children: (0, import_jsx_runtime.jsx)(ChevronUp, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							}), (0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-7 w-7 rounded-md p-0",
								onClick: onMoveDown,
								disabled: position < 0 || position >= totalEnabled - 1,
								title: "Move down",
								"aria-label": "Move down",
								children: (0, import_jsx_runtime.jsx)(ChevronDown, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							})] })
						]
					})
				]
			}),
			isInstallable && installSheetOpen && (0, import_jsx_runtime.jsx)(InstallSheet, {
				backendId: installableId,
				backendLabel: backend.label,
				methods,
				onCancel: onCloseSheets,
				onComplete: onInstallComplete
			}),
			isInstallable && signinSheetOpen && (0, import_jsx_runtime.jsx)(SigninSheet, {
				backendId: installableId,
				backendLabel: backend.label,
				onCancel: onCloseSheets,
				onComplete: onSigninComplete
			})
		]
	});
}
function StatusPill({ tone, text }) {
	const classes = tone === "ok" ? "border-ok/30 bg-ok/10 text-ok" : tone === "warn" ? "border-warn/30 bg-warn/10 text-warn" : "border-border/40 bg-bg/40 text-muted";
	const Icon = tone === "ok" ? CheckCircle2 : AlertCircle;
	return (0, import_jsx_runtime.jsxs)("span", {
		className: `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${classes}`,
		children: [(0, import_jsx_runtime.jsx)(Icon, {
			className: "h-3 w-3",
			"aria-hidden": true
		}), text]
	});
}
function InstallSheet({ backendId, backendLabel, methods, onCancel, onComplete }) {
	const [running, setRunning] = useState(false);
	const [logs, setLogs] = useState([]);
	const [error, setError] = useState(null);
	const [done, setDone] = useState(false);
	const sourceRef = useRef(null);
	const close = useCallback(() => {
		sourceRef.current?.close();
		sourceRef.current = null;
		onCancel();
	}, [onCancel]);
	useEffect(() => {
		return () => {
			sourceRef.current?.close();
			sourceRef.current = null;
		};
	}, []);
	const start = useCallback(async (method) => {
		if (method.kind === "manual") {
			window.open(method.url, "_blank", "noopener,noreferrer");
			return;
		}
		setRunning(true);
		setLogs([]);
		setError(null);
		setDone(false);
		try {
			const res = await fetch("/api/secrets/manager/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					backendId,
					method
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			const { jobId } = await res.json();
			const source = new EventSource(`/api/secrets/manager/install/${jobId}`);
			sourceRef.current = source;
			source.onmessage = (event) => {
				const data = JSON.parse(event.data);
				if (data.type === "log") setLogs((prev) => [...prev.slice(-199), data.line]);
				else if (data.type === "done") {
					setDone(true);
					setRunning(false);
					source.close();
					sourceRef.current = null;
				} else if (data.type === "error") {
					setError(data.message);
					setRunning(false);
					source.close();
					sourceRef.current = null;
				}
			};
			source.onerror = () => {
				if (!sourceRef.current) return;
				source.close();
				sourceRef.current = null;
				if (!done && !error) {
					setError("install stream disconnected");
					setRunning(false);
				}
			};
		} catch (err) {
			setError(err instanceof Error ? err.message : "install failed");
			setRunning(false);
		}
	}, [
		backendId,
		done,
		error
	]);
	const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 space-y-2 rounded-md border border-border/50 bg-bg/30 p-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("p", {
					className: "text-xs font-medium text-txt",
					children: ["Install ", backendLabel]
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "h-6 rounded-md px-2 text-2xs",
					onClick: close,
					disabled: running,
					children: "Close"
				})]
			}),
			!running && !done && (0, import_jsx_runtime.jsx)("div", {
				className: "space-y-1.5",
				children: methods.length === 0 ? (0, import_jsx_runtime.jsxs)("p", {
					className: "text-2xs text-muted",
					children: [
						"No automated installer is available on this OS for ",
						backendLabel,
						". The vendor's CLI may need a manual install."
					]
				}) : methods.map((m) => (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 w-full justify-start gap-2 rounded-md",
					onClick: () => void start(m),
					children: [m.kind === "manual" ? (0, import_jsx_runtime.jsx)(ExternalLink, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}) : (0, import_jsx_runtime.jsx)(Download, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), (0, import_jsx_runtime.jsx)("span", {
						className: "truncate text-xs",
						children: describeMethod(m)
					})]
				}, methodKey(m)))
			}),
			running && (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-1.5",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2 text-xs text-muted",
					children: [(0, import_jsx_runtime.jsx)(Loader2, {
						className: "h-3.5 w-3.5 animate-spin",
						"aria-hidden": true
					}), "Installing…"]
				}), lastLog && (0, import_jsx_runtime.jsx)("pre", {
					className: "overflow-x-auto whitespace-pre-wrap rounded border border-border/40 bg-card/40 p-2 text-2xs text-muted",
					children: lastLog
				})]
			}),
			done && !error && (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2 rounded-md border border-ok/30 bg-ok/10 px-2 py-1.5 text-xs text-ok",
				children: [(0, import_jsx_runtime.jsxs)("span", {
					className: "flex items-center gap-1.5",
					children: [(0, import_jsx_runtime.jsx)(CheckCircle2, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), "Install complete."]
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "h-6 rounded-md px-2 text-2xs",
					onClick: onComplete,
					children: "Continue"
				})]
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger",
				children: error
			})
		]
	});
}
function methodKey(method) {
	if (method.kind === "brew") return `brew:${method.cask ? "cask" : "formula"}:${method.package}`;
	if (method.kind === "npm") return `npm:${method.package}`;
	return `manual:${method.url}`;
}
function describeMethod(method) {
	if (method.kind === "brew") return method.cask ? `brew install --cask ${method.package}` : `brew install ${method.package}`;
	if (method.kind === "npm") return `npm install -g ${method.package}`;
	return `Open docs: ${method.url}`;
}
function SigninSheet({ backendId, backendLabel, onCancel, onComplete }) {
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState(null);
	const [email, setEmail] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [signInAddress, setSignInAddress] = useState("");
	const [masterPassword, setMasterPassword] = useState("");
	const [bwClientId, setBwClientId] = useState("");
	const [bwClientSecret, setBwClientSecret] = useState("");
	const onSubmit = async (e) => {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const body = {
				backendId,
				masterPassword
			};
			if (backendId === "1password") {
				body.email = email;
				body.secretKey = secretKey;
				if (signInAddress.trim()) body.signInAddress = signInAddress.trim();
			} else if (backendId === "bitwarden") {
				body.bitwardenClientId = bwClientId;
				body.bitwardenClientSecret = bwClientSecret;
			}
			const res = await fetch("/api/secrets/manager/signin", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				throw new Error(errBody.error ?? `HTTP ${res.status}`);
			}
			onComplete();
		} catch (err) {
			setError(err instanceof Error ? err.message : "sign-in failed");
		} finally {
			setSubmitting(false);
		}
	};
	return (0, import_jsx_runtime.jsxs)("form", {
		onSubmit,
		className: "mt-3 space-y-2 rounded-md border border-border/50 bg-bg/30 p-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("p", {
					className: "text-xs font-medium text-txt",
					children: ["Sign in to ", backendLabel]
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					type: "button",
					className: "h-6 rounded-md px-2 text-2xs",
					onClick: onCancel,
					disabled: submitting,
					children: "Cancel"
				})]
			}),
			backendId === "1password" && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "op-email",
						className: "text-2xs text-muted",
						children: "Email"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "op-email",
						type: "email",
						autoComplete: "username",
						required: true,
						value: email,
						onChange: (e) => setEmail(e.target.value),
						className: "h-8 text-xs"
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "op-secret-key",
						className: "text-2xs text-muted",
						children: "Secret key (34 chars)"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "op-secret-key",
						type: "text",
						required: true,
						value: secretKey,
						onChange: (e) => setSecretKey(e.target.value),
						className: "h-8 font-mono text-xs"
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "op-address",
						className: "text-2xs text-muted",
						children: "Sign-in address (optional, e.g. my.1password.com)"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "op-address",
						type: "text",
						value: signInAddress,
						onChange: (e) => setSignInAddress(e.target.value),
						className: "h-8 text-xs"
					})]
				})
			] }),
			backendId === "bitwarden" && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
				(0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs text-muted",
					children: "Bitwarden requires API key credentials for non-interactive sign-in. Create one at Settings → Security → Keys → API key."
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "bw-client-id",
						className: "text-2xs text-muted",
						children: "client_id (BW_CLIENTID)"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "bw-client-id",
						type: "text",
						required: true,
						value: bwClientId,
						onChange: (e) => setBwClientId(e.target.value),
						className: "h-8 font-mono text-xs"
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "bw-client-secret",
						className: "text-2xs text-muted",
						children: "client_secret (BW_CLIENTSECRET)"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "bw-client-secret",
						type: "password",
						autoComplete: "off",
						required: true,
						value: bwClientSecret,
						onChange: (e) => setBwClientSecret(e.target.value),
						className: "h-8 font-mono text-xs"
					})]
				})
			] }),
			backendId === "protonpass" && (0, import_jsx_runtime.jsx)("p", {
				className: "text-2xs text-warn",
				children: "Proton Pass CLI is in closed beta — automated sign-in is not yet supported."
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-1",
				children: [(0, import_jsx_runtime.jsx)(Label, {
					htmlFor: "master-password",
					className: "text-2xs text-muted",
					children: "Master password"
				}), (0, import_jsx_runtime.jsx)(Input, {
					id: "master-password",
					type: "password",
					autoComplete: "current-password",
					required: true,
					value: masterPassword,
					onChange: (e) => setMasterPassword(e.target.value),
					className: "h-8 text-xs"
				})]
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger",
				children: error
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex justify-end gap-2 pt-1",
				children: (0, import_jsx_runtime.jsx)(Button, {
					type: "submit",
					variant: "default",
					size: "sm",
					className: "h-7 gap-1 rounded-md px-3 text-xs",
					disabled: submitting || backendId === "protonpass",
					children: submitting ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Loader2, {
						className: "h-3.5 w-3.5 animate-spin",
						"aria-hidden": true
					}), "Signing in…"] }) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(LogIn, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), "Sign in"] })
				})
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/vault-tabs/RoutingTab.js
/**
* Routing tab — full-width per-context routing rules table plus the
* "Default profile" setting. One source of truth: `GET/PUT
* /api/secrets/routing`.
*
* Replaces the cramped per-row routing editor that used to live inside
* `VaultInventoryPanel`. This tab shows every rule in the system and
* supports wildcard key patterns (e.g. `OPENROUTER_*`).
*/
function RoutingTab(props) {
	const { config, agents, apps, entries, onConfigChange, navigate, focusKey, onFocusApplied } = props;
	const [error, setError] = useState(null);
	const [saving, setSaving] = useState(false);
	const [showAdd, setShowAdd] = useState(false);
	const [keyPattern, setKeyPattern] = useState("");
	const [scopeKind, setScopeKind] = useState("agent");
	const [scopeAgentId, setScopeAgentId] = useState("");
	const [scopeAppName, setScopeAppName] = useState("");
	const [profileId, setProfileId] = useState("");
	const [rulesFilter, setRulesFilter] = useState("");
	useEffect(() => {
		if (!focusKey) return;
		setRulesFilter(focusKey);
		onFocusApplied();
	}, [focusKey, onFocusApplied]);
	const allKeys = useMemo(() => entries.map((e) => e.key), [entries]);
	const profilesByKey = useMemo(() => {
		const map = /* @__PURE__ */ new Map();
		for (const entry of entries) map.set(entry.key, entry.profiles ?? []);
		return map;
	}, [entries]);
	const profilesForNewRule = useMemo(() => {
		if (!keyPattern) return [];
		const exact = profilesByKey.get(keyPattern);
		if (exact && exact.length > 0) return exact;
		const ids = /* @__PURE__ */ new Set();
		const list = [];
		for (const entry of entries) for (const p of entry.profiles ?? []) {
			if (ids.has(p.id)) continue;
			ids.add(p.id);
			list.push(p);
		}
		return list;
	}, [
		keyPattern,
		profilesByKey,
		entries
	]);
	const allProfileIds = useMemo(() => {
		const ids = new Set(["default"]);
		for (const entry of entries) for (const p of entry.profiles ?? []) ids.add(p.id);
		return Array.from(ids);
	}, [entries]);
	const saveConfig = useCallback(async (next) => {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch("/api/secrets/routing", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ config: next })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			onConfigChange((await res.json()).config);
		} catch (err) {
			setError(err instanceof Error ? err.message : "save failed");
		} finally {
			setSaving(false);
		}
	}, [onConfigChange]);
	const onAddRule = useCallback(async (e) => {
		e.preventDefault();
		if (!keyPattern.trim() || !profileId) return;
		let scope;
		if (scopeKind === "agent") {
			if (!scopeAgentId) return;
			scope = {
				kind: "agent",
				agentId: scopeAgentId
			};
		} else if (scopeKind === "app") {
			if (!scopeAppName) return;
			scope = {
				kind: "app",
				appName: scopeAppName
			};
		} else return;
		const newRules = [...config.rules, {
			keyPattern: keyPattern.trim(),
			scope,
			profileId
		}];
		await saveConfig({
			...config,
			rules: newRules
		});
		setShowAdd(false);
		setKeyPattern("");
		setScopeAgentId("");
		setScopeAppName("");
		setProfileId("");
	}, [
		config,
		keyPattern,
		profileId,
		saveConfig,
		scopeAgentId,
		scopeAppName,
		scopeKind
	]);
	const onDeleteRule = useCallback(async (rule) => {
		if (!window.confirm(`Delete routing rule for ${rule.keyPattern}?`)) return;
		const newRules = config.rules.filter((r) => r !== rule);
		await saveConfig({
			...config,
			rules: newRules
		});
	}, [config, saveConfig]);
	const onDefaultProfileChange = useCallback(async (next) => {
		const trimmed = next.trim();
		await saveConfig({
			...config,
			defaultProfile: trimmed.length > 0 ? trimmed : void 0
		});
	}, [config, saveConfig]);
	const visibleRules = useMemo(() => {
		if (!rulesFilter.trim()) return config.rules;
		const needle = rulesFilter.trim().toLowerCase();
		return config.rules.filter((r) => {
			if (r.keyPattern.toLowerCase().includes(needle)) return true;
			if ((r.scope.agentId ?? r.scope.appName ?? r.scope.skillId ?? "").toLowerCase().includes(needle)) return true;
			return r.profileId.toLowerCase().includes(needle);
		});
	}, [config.rules, rulesFilter]);
	return (0, import_jsx_runtime.jsxs)("div", {
		"data-testid": "routing-tab",
		className: "space-y-4",
		children: [(0, import_jsx_runtime.jsx)("section", {
			className: "space-y-2 rounded-md border border-border/40 bg-card/30 p-3",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-medium text-txt",
						children: "Default profile"
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Applied when no rule below matches a (key × scope) lookup. \"default\" is the fallback when this is empty."
					})]
				}), (0, import_jsx_runtime.jsx)("select", {
					value: config.defaultProfile ?? "default",
					onChange: (e) => void onDefaultProfileChange(e.target.value),
					disabled: saving,
					"data-testid": "routing-default-profile",
					className: "block h-8 w-40 rounded-md border border-border bg-bg px-2 text-xs text-txt",
					children: allProfileIds.map((id) => (0, import_jsx_runtime.jsx)("option", {
						value: id,
						children: id
					}, id))
				})]
			})
		}), (0, import_jsx_runtime.jsxs)("section", {
			className: "space-y-2",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between gap-2",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)("p", {
							className: "text-sm font-medium text-txt",
							children: "Routing rules"
						}), (0, import_jsx_runtime.jsxs)("p", {
							className: "text-2xs text-muted",
							children: [
								"Per-context overrides. Match keys exactly (e.g.",
								(0, import_jsx_runtime.jsx)("code", {
									className: "mx-1 rounded bg-bg/40 px-1 font-mono",
									children: "OPENROUTER_API_KEY"
								}),
								") or use wildcards (e.g.",
								(0, import_jsx_runtime.jsx)("code", {
									className: "mx-1 rounded bg-bg/40 px-1 font-mono",
									children: "OPENROUTER_*"
								}),
								")."
							]
						})]
					}), (0, import_jsx_runtime.jsxs)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 shrink-0 gap-1 rounded-md px-2",
						onClick: () => setShowAdd((v) => !v),
						disabled: saving,
						"aria-label": "Add routing rule",
						children: [(0, import_jsx_runtime.jsx)(Plus, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}), " Add rule"]
					})]
				}),
				error && (0, import_jsx_runtime.jsx)("p", {
					className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger",
					"aria-live": "polite",
					"data-testid": "routing-tab-error",
					children: error
				}),
				config.rules.length > 0 && (0, import_jsx_runtime.jsx)(Input, {
					value: rulesFilter,
					onChange: (e) => setRulesFilter(e.target.value),
					placeholder: "Filter rules by key, scope, or profile",
					className: "h-8 text-xs",
					autoComplete: "off",
					"data-testid": "routing-rules-filter"
				}),
				showAdd && (0, import_jsx_runtime.jsxs)("form", {
					onSubmit: onAddRule,
					"data-testid": "routing-add-rule-form",
					className: "space-y-2 rounded-md border border-border/50 bg-card/30 p-3",
					children: [
						(0, import_jsx_runtime.jsxs)("div", { children: [
							(0, import_jsx_runtime.jsx)(Label, {
								className: "text-2xs text-muted",
								children: "Key pattern"
							}),
							(0, import_jsx_runtime.jsx)(Input, {
								value: keyPattern,
								onChange: (e) => setKeyPattern(e.target.value),
								placeholder: "OPENROUTER_API_KEY or OPENROUTER_*",
								className: "h-8 font-mono text-xs",
								autoComplete: "off",
								list: "routing-key-suggestions",
								required: true
							}),
							(0, import_jsx_runtime.jsx)("datalist", {
								id: "routing-key-suggestions",
								children: allKeys.map((k) => (0, import_jsx_runtime.jsx)("option", { value: k }, k))
							})
						] }),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "grid grid-cols-1 gap-2 sm:grid-cols-3",
							children: [
								(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
									className: "text-2xs text-muted",
									children: "Scope"
								}), (0, import_jsx_runtime.jsxs)("select", {
									value: scopeKind,
									onChange: (e) => setScopeKind(e.target.value),
									className: "block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt",
									children: [(0, import_jsx_runtime.jsx)("option", {
										value: "agent",
										children: "Agent"
									}), (0, import_jsx_runtime.jsx)("option", {
										value: "app",
										children: "App"
									})]
								})] }),
								(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
									className: "text-2xs text-muted",
									children: scopeKind === "agent" ? "Agent" : "App"
								}), scopeKind === "agent" ? (0, import_jsx_runtime.jsxs)("select", {
									value: scopeAgentId,
									onChange: (e) => setScopeAgentId(e.target.value),
									className: "block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt",
									required: true,
									children: [(0, import_jsx_runtime.jsx)("option", {
										value: "",
										children: "Select agent…"
									}), agents.map((a) => (0, import_jsx_runtime.jsx)("option", {
										value: a.id,
										children: a.name
									}, a.id))]
								}) : (0, import_jsx_runtime.jsxs)("select", {
									value: scopeAppName,
									onChange: (e) => setScopeAppName(e.target.value),
									className: "block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt",
									required: true,
									children: [(0, import_jsx_runtime.jsx)("option", {
										value: "",
										children: "Select app…"
									}), apps.map((a) => (0, import_jsx_runtime.jsx)("option", {
										value: a.name,
										children: a.displayName ?? a.name
									}, a.name))]
								})] }),
								(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
									className: "text-2xs text-muted",
									children: "Profile"
								}), (0, import_jsx_runtime.jsxs)("select", {
									value: profileId,
									onChange: (e) => setProfileId(e.target.value),
									className: "block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt",
									required: true,
									children: [(0, import_jsx_runtime.jsx)("option", {
										value: "",
										children: "Select profile…"
									}), profilesForNewRule.map((p) => (0, import_jsx_runtime.jsx)("option", {
										value: p.id,
										children: p.label
									}, p.id))]
								})] })
							]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex justify-end gap-2 pt-1",
							children: [(0, import_jsx_runtime.jsx)(Button, {
								type: "button",
								variant: "ghost",
								size: "sm",
								className: "h-7 rounded-md px-3 text-xs",
								onClick: () => setShowAdd(false),
								disabled: saving,
								children: "Cancel"
							}), (0, import_jsx_runtime.jsx)(Button, {
								type: "submit",
								variant: "default",
								size: "sm",
								className: "h-7 rounded-md px-3 text-xs",
								disabled: saving || !keyPattern.trim() || !profileId,
								children: saving ? "Saving…" : "Save rule"
							})]
						})
					]
				}),
				config.rules.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
					"data-testid": "routing-rules-empty",
					className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
					children: "No routing rules. The default profile applies for every caller."
				}) : visibleRules.length === 0 ? (0, import_jsx_runtime.jsxs)("div", {
					"data-testid": "routing-rules-no-match",
					className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
					children: [
						"No rules match \"",
						rulesFilter,
						"\"."
					]
				}) : (0, import_jsx_runtime.jsxs)("table", {
					"data-testid": "routing-rules-table",
					className: "w-full table-fixed border-collapse rounded-md border border-border/40 bg-card/30 text-xs",
					children: [(0, import_jsx_runtime.jsx)("thead", { children: (0, import_jsx_runtime.jsxs)("tr", {
						className: "text-left text-muted",
						children: [
							(0, import_jsx_runtime.jsx)("th", {
								className: "px-2 py-1 font-medium",
								children: "Key"
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: "px-2 py-1 font-medium",
								children: "Scope"
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: "px-2 py-1 font-medium",
								children: "Profile"
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: "w-16 px-2 py-1 font-medium text-right",
								children: "Actions"
							})
						]
					}) }), (0, import_jsx_runtime.jsx)("tbody", { children: visibleRules.map((rule, idx) => {
						const targetId = rule.scope.agentId ?? rule.scope.appName ?? rule.scope.skillId ?? "—";
						const targetLabel = rule.scope.kind === "agent" ? agents.find((a) => a.id === rule.scope.agentId)?.name ?? targetId : rule.scope.kind === "app" ? apps.find((a) => a.name === rule.scope.appName)?.displayName ?? targetId : targetId;
						const ruleKey = `${rule.keyPattern}:${rule.scope.kind}:${targetId}:${rule.profileId}:${idx}`;
						const keyExists = allKeys.includes(rule.keyPattern);
						return (0, import_jsx_runtime.jsxs)("tr", {
							"data-testid": `routing-rule-row-${ruleKey}`,
							className: "border-t border-border/30",
							children: [
								(0, import_jsx_runtime.jsx)("td", {
									className: "px-2 py-1.5 align-top",
									children: keyExists ? (0, import_jsx_runtime.jsxs)("button", {
										type: "button",
										onClick: () => navigate({
											tab: "secrets",
											focusKey: rule.keyPattern,
											focusProfileId: rule.profileId
										}),
										"data-testid": `routing-key-chip-${ruleKey}`,
										className: "inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs font-medium text-accent hover:bg-accent/20",
										"aria-label": `Open ${rule.keyPattern} in Secrets tab`,
										children: [rule.keyPattern, (0, import_jsx_runtime.jsx)(ArrowRight, {
											className: "h-3 w-3",
											"aria-hidden": true
										})]
									}) : (0, import_jsx_runtime.jsx)("span", {
										className: "font-mono text-2xs text-muted",
										children: rule.keyPattern
									})
								}),
								(0, import_jsx_runtime.jsxs)("td", {
									className: "px-2 py-1.5 align-top",
									children: [(0, import_jsx_runtime.jsx)("span", {
										className: "rounded-full border border-border/40 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted",
										children: rule.scope.kind
									}), (0, import_jsx_runtime.jsx)("span", {
										className: "ml-1.5 text-2xs text-txt",
										children: targetLabel
									})]
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: "px-2 py-1.5 align-top",
									children: (0, import_jsx_runtime.jsx)("span", {
										className: "rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
										children: rule.profileId
									})
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: "px-2 py-1.5 align-top text-right",
									children: (0, import_jsx_runtime.jsx)(Button, {
										variant: "ghost",
										size: "sm",
										className: "h-6 w-6 rounded-md p-0 text-muted hover:text-danger",
										onClick: () => void onDeleteRule(rule),
										"aria-label": `Delete rule for ${rule.keyPattern}`,
										children: (0, import_jsx_runtime.jsx)(Trash2, {
											className: "h-3.5 w-3.5",
											"aria-hidden": true
										})
									})
								})
							]
						}, ruleKey);
					}) })]
				}),
				saving && (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2 px-1 text-2xs text-muted",
					children: [(0, import_jsx_runtime.jsx)(Loader2, {
						className: "h-3 w-3 animate-spin",
						"aria-hidden": true
					}), " Saving…"]
				})
			]
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/VaultInventoryPanel.js
/**
* Vault inventory panel — shows every secret stored, grouped by category,
* with reveal / edit / delete and per-key profile management.
*
* Endpoints driven:
*   GET    /api/secrets/inventory                       (load list)
*   GET    /api/secrets/inventory/:key                  (reveal, on demand)
*   PUT    /api/secrets/inventory/:key                  (add or replace)
*   DELETE /api/secrets/inventory/:key                  (drop)
*   GET    /api/secrets/inventory/:key/profiles         (profile list)
*   POST   /api/secrets/inventory/:key/profiles         (add)
*   PATCH  /api/secrets/inventory/:key/profiles/:id     (update)
*   DELETE /api/secrets/inventory/:key/profiles/:id     (drop)
*   PUT    /api/secrets/inventory/:key/active-profile   (switch active)
*   POST   /api/secrets/inventory/migrate-to-profiles   (opt-in promotion)
*
* Routing rules live in a sibling tab (`RoutingTab`); the per-key
* "Routing rules for this profile →" affordance hands control back to
* the Vault modal via `onJumpToRouting`.
*
* Hard rule: revealed values never persist in component state past the
* 10-second auto-hide window.
*/
const CATEGORY_LABEL = {
	provider: "Providers",
	plugin: "Plugins",
	wallet: "Wallet",
	credential: "Saved logins",
	session: "Sessions",
	system: "System"
};
const CATEGORY_ORDER$1 = [
	"provider",
	"plugin",
	"wallet",
	"credential",
	"session",
	"system"
];
const CATEGORY_INPUT_OPTIONS = [
	{
		value: "provider",
		label: "Provider"
	},
	{
		value: "plugin",
		label: "Plugin"
	},
	{
		value: "wallet",
		label: "Wallet"
	},
	{
		value: "credential",
		label: "Saved login"
	},
	{
		value: "session",
		label: "Session"
	},
	{
		value: "system",
		label: "System"
	}
];
function VaultInventoryPanel(props = {}) {
	const { entries: externalEntries, onChanged: externalOnChanged, onJumpToRouting, focusKey, focusProfileId, onFocusApplied } = props;
	const ownsData = externalEntries === void 0;
	const [internalEntries, setInternalEntries] = useState(null);
	const [error, setError] = useState(null);
	const [showAdd, setShowAdd] = useState(false);
	const load = useCallback(async () => {
		setError(null);
		try {
			const res = await fetch("/api/secrets/inventory");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setInternalEntries((await res.json()).entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : "load failed");
			setInternalEntries([]);
		}
	}, []);
	useEffect(() => {
		if (!ownsData) return;
		load();
	}, [load, ownsData]);
	const onChanged = useCallback(() => {
		if (externalOnChanged) externalOnChanged();
		else load();
	}, [externalOnChanged, load]);
	const entries = ownsData ? internalEntries : externalEntries ?? [];
	const grouped = useMemo(() => {
		const buckets = {
			provider: [],
			plugin: [],
			wallet: [],
			credential: [],
			session: [],
			system: []
		};
		for (const e of entries ?? []) buckets[e.category].push(e);
		return buckets;
	}, [entries]);
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": "vault-inventory-panel",
		className: "space-y-2 pt-1",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-medium text-txt",
						children: "Stored secrets"
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Every secret stored locally, grouped by category. Add API keys, wallet keys, and plugin tokens here."
					})]
				}), (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 shrink-0 gap-1 rounded-md px-2",
					onClick: () => setShowAdd((v) => !v),
					"aria-label": "Add secret",
					children: [(0, import_jsx_runtime.jsx)(Plus, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), "Add secret"]
				})]
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				"aria-live": "polite",
				"data-testid": "vault-inventory-error",
				className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger",
				children: error
			}),
			showAdd && (0, import_jsx_runtime.jsx)(AddSecretForm, {
				onClose: () => setShowAdd(false),
				onSaved: () => {
					setShowAdd(false);
					onChanged();
				}
			}),
			entries === null ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-1 py-3 text-xs text-muted",
				children: [(0, import_jsx_runtime.jsx)(Loader2, {
					className: "h-3.5 w-3.5 animate-spin",
					"aria-hidden": true
				}), " Loading…"]
			}) : entries.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
				"data-testid": "vault-inventory-empty",
				className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
				children: "No secrets stored yet. Add an API key to get started."
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "space-y-3",
				children: CATEGORY_ORDER$1.map((cat) => {
					const rows = grouped[cat];
					if (rows.length === 0) return null;
					return (0, import_jsx_runtime.jsx)(CategoryGroup, {
						category: cat,
						entries: rows,
						onChanged,
						onJumpToRouting,
						focusKey: focusKey ?? null,
						focusProfileId: focusProfileId ?? null,
						onFocusApplied
					}, cat);
				})
			})
		]
	});
}
function CategoryGroup({ category, entries, onChanged, onJumpToRouting, focusKey, focusProfileId, onFocusApplied }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		"data-testid": `vault-category-${category}`,
		className: "space-y-1",
		children: [(0, import_jsx_runtime.jsx)("p", {
			className: "text-2xs font-semibold uppercase tracking-wide text-muted",
			children: CATEGORY_LABEL[category]
		}), (0, import_jsx_runtime.jsx)("ul", {
			className: "space-y-1 rounded-md border border-border/40 bg-card/30 p-1",
			children: entries.map((entry) => (0, import_jsx_runtime.jsx)("li", { children: (0, import_jsx_runtime.jsx)(EntryRow, {
				entry,
				onChanged,
				onJumpToRouting,
				focusKey,
				focusProfileId,
				onFocusApplied
			}) }, entry.key))
		})]
	});
}
function EntryRow({ entry, onChanged, onJumpToRouting, focusKey, focusProfileId, onFocusApplied }) {
	const [revealed, setRevealed] = useState(null);
	const [revealError, setRevealError] = useState(null);
	const [revealing, setRevealing] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const rowRef = useRef(null);
	useEffect(() => {
		if (focusKey !== entry.key) return;
		setExpanded(true);
		if (rowRef.current && typeof rowRef.current.scrollIntoView === "function") rowRef.current.scrollIntoView({
			behavior: "smooth",
			block: "center"
		});
		if (onFocusApplied) {
			const id = window.setTimeout(onFocusApplied, 250);
			return () => window.clearTimeout(id);
		}
	}, [
		focusKey,
		entry.key,
		onFocusApplied
	]);
	useEffect(() => {
		if (!revealed) return;
		const id = setTimeout(() => setRevealed(null), 1e4);
		return () => clearTimeout(id);
	}, [revealed]);
	const reveal = useCallback(async () => {
		setRevealing(true);
		setRevealError(null);
		const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}`);
		if (!res.ok) {
			setRevealError(`HTTP ${res.status}`);
			setRevealing(false);
			return;
		}
		setRevealed(await res.json());
		setRevealing(false);
	}, [entry.key]);
	const hide = useCallback(() => setRevealed(null), []);
	const copy = useCallback(async () => {
		if (!revealed) return;
		if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(revealed.value);
	}, [revealed]);
	const onDelete = useCallback(async () => {
		if (!window.confirm(`Delete "${entry.label}"? This drops the value, every profile, and the metadata.`)) return;
		if ((await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}`, { method: "DELETE" })).ok) onChanged();
	}, [
		entry.key,
		entry.label,
		onChanged
	]);
	const profileCount = entry.profiles?.length ?? 0;
	return (0, import_jsx_runtime.jsxs)("div", {
		ref: rowRef,
		"data-testid": `vault-entry-row-${entry.key}`,
		className: "rounded px-2 py-1.5 hover:bg-bg-muted/30",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-6 w-6 shrink-0 rounded-md p-0 text-muted",
						onClick: () => setExpanded((v) => !v),
						"aria-label": expanded ? "Collapse" : "Expand",
						children: expanded ? (0, import_jsx_runtime.jsx)(ChevronDown, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}) : (0, import_jsx_runtime.jsx)(ChevronRight, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						})
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0 flex-1",
						children: [(0, import_jsx_runtime.jsx)("p", {
							className: "truncate text-xs font-medium text-txt",
							children: entry.label
						}), (0, import_jsx_runtime.jsx)("p", {
							className: "truncate font-mono text-2xs text-muted",
							children: entry.key
						})]
					}),
					profileCount > 0 && (0, import_jsx_runtime.jsxs)("span", {
						"data-testid": `profile-badge-${entry.key}`,
						className: "shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
						children: [
							profileCount,
							" profile",
							profileCount === 1 ? "" : "s"
						]
					}),
					!revealed ? (0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted",
						onClick: () => void reveal(),
						disabled: revealing,
						"aria-label": `Reveal ${entry.label}`,
						children: [revealing ? (0, import_jsx_runtime.jsx)(Loader2, {
							className: "h-3.5 w-3.5 animate-spin",
							"aria-hidden": true
						}) : (0, import_jsx_runtime.jsx)(Eye, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}), "Reveal"]
					}) : (0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted",
						onClick: hide,
						"aria-label": `Hide ${entry.label}`,
						children: [(0, import_jsx_runtime.jsx)(EyeOff, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}), "Hide"]
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-danger",
						onClick: () => void onDelete(),
						"aria-label": `Delete ${entry.label}`,
						children: (0, import_jsx_runtime.jsx)(Trash2, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						})
					})
				]
			}),
			revealed && (0, import_jsx_runtime.jsxs)("div", {
				"data-testid": `vault-revealed-${entry.key}`,
				className: "mt-1.5 flex items-center gap-2 rounded-md border border-border/50 bg-bg/40 p-2",
				children: [
					(0, import_jsx_runtime.jsx)("code", {
						className: "flex-1 truncate font-mono text-2xs text-txt",
						children: revealed.value
					}),
					revealed.source === "profile" && revealed.profileId && (0, import_jsx_runtime.jsx)("span", {
						className: "shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs text-accent",
						children: revealed.profileId
					}),
					(0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-6 shrink-0 gap-1 rounded-md px-2 text-2xs",
						onClick: () => void copy(),
						"aria-label": "Copy",
						children: [(0, import_jsx_runtime.jsx)(Copy, {
							className: "h-3 w-3",
							"aria-hidden": true
						}), " Copy"]
					})
				]
			}),
			revealError && (0, import_jsx_runtime.jsx)("p", {
				className: "mt-1 text-2xs text-danger",
				children: revealError
			}),
			expanded && (0, import_jsx_runtime.jsx)(ProfilesPanel, {
				entry,
				onChanged,
				onJumpToRouting,
				highlightProfileId: focusKey === entry.key ? focusProfileId : null
			})
		]
	});
}
function ProfilesPanel({ entry, onChanged, onJumpToRouting, highlightProfileId }) {
	const [showAdd, setShowAdd] = useState(false);
	const [newId, setNewId] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [newValue, setNewValue] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [err, setErr] = useState(null);
	const [migrating, setMigrating] = useState(false);
	const profiles = entry.profiles ?? [];
	const hasProfiles = profiles.length > 0;
	const onAdd = useCallback(async (e) => {
		e.preventDefault();
		if (!newId || !newValue) return;
		setSubmitting(true);
		setErr(null);
		const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}/profiles`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: newId,
				label: newLabel || newId,
				value: newValue
			})
		});
		setSubmitting(false);
		if (!res.ok) {
			setErr(`HTTP ${res.status}`);
			return;
		}
		setNewId("");
		setNewLabel("");
		setNewValue("");
		setShowAdd(false);
		onChanged();
	}, [
		entry.key,
		newId,
		newLabel,
		newValue,
		onChanged
	]);
	const onActivate = useCallback(async (profileId) => {
		if ((await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}/active-profile`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profileId })
		})).ok) onChanged();
	}, [entry.key, onChanged]);
	const onDelete = useCallback(async (profileId) => {
		if (!window.confirm(`Delete profile "${profileId}"?`)) return;
		if ((await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" })).ok) onChanged();
	}, [entry.key, onChanged]);
	const onMigrate = useCallback(async () => {
		setMigrating(true);
		setErr(null);
		const res = await fetch("/api/secrets/inventory/migrate-to-profiles", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: entry.key })
		});
		setMigrating(false);
		if (!res.ok) {
			setErr(`HTTP ${res.status}`);
			return;
		}
		onChanged();
	}, [entry.key, onChanged]);
	return (0, import_jsx_runtime.jsxs)("div", {
		"data-testid": `profiles-panel-${entry.key}`,
		className: "mt-2 space-y-2 rounded-md border border-border/40 bg-bg/30 p-2",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs font-semibold uppercase text-muted",
					children: "Profiles"
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-1",
					children: [hasProfiles && onJumpToRouting && (0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-6 gap-1 rounded-md px-2 text-2xs",
						onClick: () => onJumpToRouting(entry.key),
						"aria-label": `Routing rules for ${entry.label}`,
						children: ["Routing rules for this profile", (0, import_jsx_runtime.jsx)(ArrowRight, {
							className: "h-3 w-3",
							"aria-hidden": true
						})]
					}), hasProfiles ? (0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-6 gap-1 rounded-md px-2 text-2xs",
						onClick: () => setShowAdd((v) => !v),
						"aria-label": "Add profile",
						children: [(0, import_jsx_runtime.jsx)(Plus, {
							className: "h-3 w-3",
							"aria-hidden": true
						}), " Add profile"]
					}) : (0, import_jsx_runtime.jsxs)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-6 gap-1 rounded-md px-2 text-2xs",
						onClick: () => void onMigrate(),
						disabled: migrating,
						"aria-label": "Enable profiles for this key",
						children: [migrating ? (0, import_jsx_runtime.jsx)(Loader2, {
							className: "h-3 w-3 animate-spin",
							"aria-hidden": true
						}) : (0, import_jsx_runtime.jsx)(Plus, {
							className: "h-3 w-3",
							"aria-hidden": true
						}), "Enable profiles"]
					})]
				})]
			}),
			err && (0, import_jsx_runtime.jsx)("p", {
				className: "text-2xs text-danger",
				"aria-live": "polite",
				children: err
			}),
			hasProfiles && (0, import_jsx_runtime.jsx)("ul", {
				className: "space-y-1",
				children: profiles.map((p) => {
					return (0, import_jsx_runtime.jsxs)("li", {
						className: `flex items-center gap-2 rounded px-1.5 py-1 text-xs ${highlightProfileId === p.id ? "ring-1 ring-accent/40" : ""}`,
						children: [
							(0, import_jsx_runtime.jsx)("input", {
								type: "radio",
								name: `active-${entry.key}`,
								checked: entry.activeProfile === p.id,
								onChange: () => void onActivate(p.id),
								className: "h-3 w-3 cursor-pointer accent-accent",
								"aria-label": `Make ${p.label} active`
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [(0, import_jsx_runtime.jsx)("p", {
									className: "truncate font-medium text-txt",
									children: p.label
								}), (0, import_jsx_runtime.jsx)("p", {
									className: "truncate font-mono text-2xs text-muted",
									children: p.id
								})]
							}),
							entry.activeProfile === p.id && (0, import_jsx_runtime.jsxs)("span", {
								className: "shrink-0 inline-flex items-center gap-0.5 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
								children: [(0, import_jsx_runtime.jsx)(CheckCircle2, {
									className: "h-3 w-3",
									"aria-hidden": true
								}), " Active"]
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-6 w-6 shrink-0 rounded-md p-0 text-muted hover:text-danger",
								"aria-label": `Delete profile ${p.label}`,
								onClick: () => void onDelete(p.id),
								children: (0, import_jsx_runtime.jsx)(Trash2, {
									className: "h-3 w-3",
									"aria-hidden": true
								})
							})
						]
					}, p.id);
				})
			}),
			showAdd && (0, import_jsx_runtime.jsxs)("form", {
				onSubmit: onAdd,
				"data-testid": `add-profile-form-${entry.key}`,
				className: "space-y-1.5 rounded-md border border-border/40 bg-card/40 p-2",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "grid grid-cols-1 gap-1.5 sm:grid-cols-2",
						children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
							className: "text-2xs text-muted",
							children: "Profile id"
						}), (0, import_jsx_runtime.jsx)(Input, {
							value: newId,
							onChange: (e) => setNewId(e.target.value),
							placeholder: "work",
							className: "h-7 text-xs",
							pattern: "[A-Za-z0-9_-]+",
							required: true
						})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
							className: "text-2xs text-muted",
							children: "Display label"
						}), (0, import_jsx_runtime.jsx)(Input, {
							value: newLabel,
							onChange: (e) => setNewLabel(e.target.value),
							placeholder: "Work",
							className: "h-7 text-xs"
						})] })]
					}),
					(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
						className: "text-2xs text-muted",
						children: "Value"
					}), (0, import_jsx_runtime.jsx)(Input, {
						type: "password",
						autoComplete: "off",
						value: newValue,
						onChange: (e) => setNewValue(e.target.value),
						className: "h-7 font-mono text-xs",
						required: true
					})] }),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex justify-end gap-2 pt-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							className: "h-6 rounded-md px-2 text-2xs",
							onClick: () => setShowAdd(false),
							disabled: submitting,
							children: "Cancel"
						}), (0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							variant: "default",
							size: "sm",
							className: "h-6 rounded-md px-2 text-2xs",
							disabled: submitting || !newId || !newValue,
							children: submitting ? "Saving…" : "Save profile"
						})]
					})
				]
			})
		]
	});
}
function AddSecretForm({ onClose, onSaved }) {
	const [key, setKey] = useState("");
	const [value, setValue] = useState("");
	const [label, setLabel] = useState("");
	const [providerId, setProviderId] = useState("");
	const [category, setCategory] = useState("plugin");
	const [submitting, setSubmitting] = useState(false);
	const [err, setErr] = useState(null);
	return (0, import_jsx_runtime.jsxs)("form", {
		onSubmit: useCallback(async (event) => {
			event.preventDefault();
			if (!key.trim() || !value) return;
			setSubmitting(true);
			setErr(null);
			const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(key.trim())}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					value,
					...label.trim() ? { label: label.trim() } : {},
					...providerId.trim() ? { providerId: providerId.trim() } : {},
					category
				})
			});
			setSubmitting(false);
			if (!res.ok) {
				setErr(`HTTP ${res.status}`);
				return;
			}
			onSaved();
		}, [
			category,
			key,
			label,
			providerId,
			value,
			onSaved
		]),
		"data-testid": "vault-add-secret-form",
		className: "space-y-2 rounded-md border border-border/50 bg-card/30 p-2",
		children: [
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-2xs text-muted",
				children: "Stored locally and encrypted at rest. The key is the env-var-style identifier; the value is what plugins read at runtime."
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid grid-cols-1 gap-2 sm:grid-cols-2",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
					className: "text-2xs text-muted",
					children: "Key"
				}), (0, import_jsx_runtime.jsx)(Input, {
					value: key,
					onChange: (e) => setKey(e.target.value),
					placeholder: "OPENROUTER_API_KEY",
					className: "h-8 font-mono text-xs",
					autoComplete: "off",
					required: true
				})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
					className: "text-2xs text-muted",
					children: "Display label"
				}), (0, import_jsx_runtime.jsx)(Input, {
					value: label,
					onChange: (e) => setLabel(e.target.value),
					placeholder: "OpenRouter",
					className: "h-8 text-xs",
					autoComplete: "off"
				})] })]
			}),
			(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
				className: "text-2xs text-muted",
				children: "Value"
			}), (0, import_jsx_runtime.jsx)(Input, {
				type: "password",
				value,
				onChange: (e) => setValue(e.target.value),
				className: "h-8 font-mono text-xs",
				autoComplete: "new-password",
				required: true
			})] }),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid grid-cols-1 gap-2 sm:grid-cols-2",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
					className: "text-2xs text-muted",
					children: "Category"
				}), (0, import_jsx_runtime.jsx)("select", {
					value: category,
					onChange: (e) => setCategory(e.target.value),
					className: "block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt",
					children: CATEGORY_INPUT_OPTIONS.map((opt) => (0, import_jsx_runtime.jsx)("option", {
						value: opt.value,
						children: opt.label
					}, opt.value))
				})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
					className: "text-2xs text-muted",
					children: "Provider id (optional)"
				}), (0, import_jsx_runtime.jsx)(Input, {
					value: providerId,
					onChange: (e) => setProviderId(e.target.value),
					placeholder: "openrouter",
					className: "h-8 text-xs",
					autoComplete: "off"
				})] })]
			}),
			err && (0, import_jsx_runtime.jsx)("p", {
				className: "text-2xs text-danger",
				"aria-live": "polite",
				children: err
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex justify-end gap-2 pt-1",
				children: [(0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					className: "h-7 rounded-md px-3 text-xs",
					onClick: onClose,
					disabled: submitting,
					children: "Cancel"
				}), (0, import_jsx_runtime.jsx)(Button, {
					type: "submit",
					variant: "default",
					size: "sm",
					className: "h-7 rounded-md px-3 text-xs",
					disabled: submitting || !key.trim() || !value,
					children: submitting ? "Saving…" : "Save secret"
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/vault-tabs/SecretsTab.js
/**
* Secrets tab — wraps `VaultInventoryPanel` with the Vault modal's
* shared data state and cross-tab navigation contract.
*
* The parent modal owns the entries fetch; this tab only renders.
*/
function SecretsTab({ entries, onChanged, navigate, focusKey, focusProfileId, onFocusApplied }) {
	return (0, import_jsx_runtime.jsx)(VaultInventoryPanel, {
		entries,
		onChanged,
		onJumpToRouting: (key) => navigate({
			tab: "routing",
			focusKey: key
		}),
		focusKey,
		focusProfileId,
		onFocusApplied
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/SecretsManagerSection.js
/**
* Settings → Vault section.
*
* Two exports:
*  - `SecretsManagerSection` — the inline launcher row in Settings.
*    Shows current primary backend + status; clicking dispatches the
*    global open event for the modal. Doesn't mount the modal itself.
*  - `SecretsManagerModalRoot` — the modal's top-level mount. Should
*    be rendered ONCE at app root (alongside SaveCommandModal etc.
*    in App.tsx). Subscribes to global open/close state so any
*    trigger (Settings launcher, ⌘⌥⌃V keyboard chord, application
*    menu accelerator) shows it.
*
* The modal itself is a tabbed Vault interface: Overview / Secrets /
* Logins / Routing. Each tab is a separate file under `vault-tabs/`.
* Data is fetched once per modal-open and shared across tabs via
* props; mutations call back to the modal to refresh.
*/
const HASH_PREFIX = "vault";
function readHashTab() {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash.replace(/^#/, "");
	if (!hash.startsWith(`${HASH_PREFIX}/`)) return null;
	const candidate = hash.slice(6);
	return VAULT_TABS.includes(candidate) ? candidate : null;
}
function writeHashTab(tab) {
	if (typeof window === "undefined") return;
	const next = `#${HASH_PREFIX}/${tab}`;
	if (window.location.hash === next) return;
	history.replaceState(null, "", next);
}
function clearHash() {
	if (typeof window === "undefined") return;
	if (!window.location.hash.startsWith(`#${HASH_PREFIX}`)) return;
	history.replaceState(null, "", window.location.pathname + window.location.search);
}
function SecretsManagerSection() {
	const [primary, setPrimary] = useState(null);
	const [enabledCount, setEnabledCount] = useState(1);
	const { isOpen } = useSecretsManagerModalState();
	const refreshSummary = useCallback(async () => {
		const [bRes, pRes] = await Promise.all([fetch("/api/secrets/manager/backends"), fetch("/api/secrets/manager/preferences")]);
		if (!bRes.ok || !pRes.ok) return;
		const bJson = await bRes.json();
		const pJson = await pRes.json();
		const primaryId = pJson.preferences.enabled[0] ?? "in-house";
		setPrimary(bJson.backends.find((b) => b.id === primaryId) ?? null);
		setEnabledCount(pJson.preferences.enabled.length);
	}, []);
	useEffect(() => {
		refreshSummary();
	}, [refreshSummary]);
	useEffect(() => {
		if (!isOpen) refreshSummary();
	}, [isOpen, refreshSummary]);
	return (0, import_jsx_runtime.jsx)("section", {
		className: "space-y-3",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-3",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-2.5",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted",
					children: (0, import_jsx_runtime.jsx)(KeyRound, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					})
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [
							(0, import_jsx_runtime.jsx)("span", {
								className: "truncate font-medium text-sm text-txt",
								children: primary?.label ?? "Local (encrypted)"
							}),
							primary && (0, import_jsx_runtime.jsx)("span", {
								className: "rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
								children: "Primary"
							}),
							enabledCount > 1 && (0, import_jsx_runtime.jsxs)("span", {
								className: "rounded-full border border-border/50 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted",
								children: [
									"+",
									enabledCount - 1,
									" more"
								]
							})
						]
					}), (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-0.5 truncate text-2xs text-muted",
						children: ["Where sensitive values like API keys are stored.", (0, import_jsx_runtime.jsxs)("span", {
							className: "ml-1 text-muted/70",
							children: [
								"(",
								getShortcutLabel(),
								")"
							]
						})]
					})]
				})]
			}), (0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-9 shrink-0 rounded-lg",
				onClick: () => dispatchSecretsManagerOpen(),
				children: "Manage…"
			})]
		})
	});
}
function SecretsManagerModalRoot() {
	const { isOpen, initialTab, focusKey, focusProfileId, setOpen, clearFocus } = useSecretsManagerModalState();
	return (0, import_jsx_runtime.jsx)(VaultModal, {
		open: isOpen,
		onOpenChange: setOpen,
		initialTab,
		initialFocusKey: focusKey,
		initialFocusProfileId: focusProfileId,
		onConsumeInitial: clearFocus
	});
}
function VaultModal({ open, onOpenChange, initialTab = null, initialFocusKey = null, initialFocusProfileId = null, onConsumeInitial }) {
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open,
		onOpenChange,
		children: (0, import_jsx_runtime.jsx)(DialogContent, {
			className: "flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-4xl",
			children: (0, import_jsx_runtime.jsx)(VaultBody, {
				open,
				onOpenChange,
				initialTab,
				initialFocusKey,
				initialFocusProfileId,
				onConsumeInitial
			})
		})
	});
}
function VaultBody({ open, onOpenChange, initialTab, initialFocusKey, initialFocusProfileId, onConsumeInitial }) {
	const priorHashRef = useRef("");
	const [activeTab, setActiveTab] = useState(() => initialTab ?? readHashTab() ?? "overview");
	const [focusKey, setFocusKey] = useState(initialFocusKey);
	const [focusProfileId, setFocusProfileId] = useState(initialFocusProfileId);
	const clearFocusState = useCallback(() => {
		setFocusKey(null);
		setFocusProfileId(null);
	}, []);
	useEffect(() => {
		if (!open) return;
		if (initialTab) setActiveTab(initialTab);
		if (initialFocusKey !== null) setFocusKey(initialFocusKey);
		if (initialFocusProfileId !== null) setFocusProfileId(initialFocusProfileId);
		if (initialTab || initialFocusKey || initialFocusProfileId) onConsumeInitial?.();
	}, [
		open,
		initialTab,
		initialFocusKey,
		initialFocusProfileId,
		onConsumeInitial
	]);
	useEffect(() => {
		if (!open) return;
		if (typeof window === "undefined") return;
		const current = window.location.hash;
		if (!current.startsWith(`#${HASH_PREFIX}`)) priorHashRef.current = current;
	}, [open]);
	useEffect(() => {
		if (!open) return;
		writeHashTab(activeTab);
	}, [open, activeTab]);
	useEffect(() => {
		if (open) return;
		if (typeof window === "undefined") return;
		if (!window.location.hash.startsWith(`#${HASH_PREFIX}`)) return;
		if (priorHashRef.current) history.replaceState(null, "", priorHashRef.current);
		else clearHash();
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onHashChange = () => {
			const next = readHashTab();
			if (next && next !== activeTab) setActiveTab(next);
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [open, activeTab]);
	const [backends, setBackends] = useState(null);
	const [preferences, setPreferences] = useState(null);
	const [installMethods, setInstallMethods] = useState(null);
	const [entries, setEntries] = useState(null);
	const [routingConfig, setRoutingConfig] = useState(null);
	const [agents, setAgents] = useState([]);
	const [apps, setApps] = useState([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	const [savedAt, setSavedAt] = useState(null);
	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [backendsRes, prefsRes, methodsRes, entriesRes, routingRes, agentsRes, appsRes] = await Promise.all([
				fetch("/api/secrets/manager/backends"),
				fetch("/api/secrets/manager/preferences"),
				fetch("/api/secrets/manager/install/methods"),
				fetch("/api/secrets/inventory"),
				fetch("/api/secrets/routing"),
				fetch("/api/agents").catch(() => null),
				fetch("/api/apps").catch(() => null)
			]);
			if (!backendsRes.ok) throw new Error(`backends: HTTP ${backendsRes.status}`);
			if (!prefsRes.ok) throw new Error(`preferences: HTTP ${prefsRes.status}`);
			if (!methodsRes.ok) throw new Error(`install/methods: HTTP ${methodsRes.status}`);
			if (!entriesRes.ok) throw new Error(`inventory: HTTP ${entriesRes.status}`);
			if (!routingRes.ok) throw new Error(`routing: HTTP ${routingRes.status}`);
			const backendsJson = await backendsRes.json();
			const prefsJson = await prefsRes.json();
			const methodsJson = await methodsRes.json();
			const entriesJson = await entriesRes.json();
			const routingJson = await routingRes.json();
			setBackends(backendsJson.backends);
			setPreferences(prefsJson.preferences);
			setInstallMethods(methodsJson.methods);
			setEntries(entriesJson.entries);
			setRoutingConfig(routingJson.config);
			if (agentsRes?.ok) setAgents((await agentsRes.json()).agents ?? []);
			else setAgents([]);
			if (appsRes?.ok) setApps((await appsRes.json()).apps ?? []);
			else setApps([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "load failed");
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		if (open) load();
	}, [open, load]);
	const refreshInventory = useCallback(async () => {
		const [entriesRes, routingRes] = await Promise.all([fetch("/api/secrets/inventory"), fetch("/api/secrets/routing")]);
		if (entriesRes.ok) setEntries((await entriesRes.json()).entries);
		if (routingRes.ok) setRoutingConfig((await routingRes.json()).config);
	}, []);
	useEffect(() => {
		if (savedAt === null) return;
		const id = setTimeout(() => setSavedAt(null), 2500);
		return () => clearTimeout(id);
	}, [savedAt]);
	const save = useCallback(async () => {
		if (!preferences) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch("/api/secrets/manager/preferences", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ preferences })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setPreferences((await res.json()).preferences);
			setSavedAt(Date.now());
		} catch (err) {
			setError(err instanceof Error ? err.message : "save failed");
		} finally {
			setSaving(false);
		}
	}, [preferences]);
	const onSignout = useCallback(async (backendId) => {
		const res = await fetch("/api/secrets/manager/signout", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ backendId })
		});
		if (!res.ok) {
			setError(`sign-out HTTP ${res.status}`);
			return;
		}
		await load();
	}, [load]);
	const navigate = useMemo(() => (target) => {
		setActiveTab(target.tab);
		setFocusKey(target.focusKey ?? null);
		setFocusProfileId(target.focusProfileId ?? null);
	}, []);
	const onTabChange = useCallback((next) => {
		if (VAULT_TABS.includes(next)) setActiveTab(next);
	}, []);
	const isReady = !loading && backends && preferences && installMethods;
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsxs)(DialogHeader, {
			className: "shrink-0",
			children: [(0, import_jsx_runtime.jsxs)(DialogTitle, {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("span", {
					className: "flex items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(KeyRound, {
						className: "h-4 w-4 text-muted",
						"aria-hidden": true
					}), "Vault"]
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "rounded-md border border-border/50 bg-bg/40 px-2 py-0.5 font-mono text-2xs font-normal text-muted",
					children: getShortcutLabel()
				})]
			}), (0, import_jsx_runtime.jsx)(DialogDescription, { children: "One stop for backends, secrets, saved logins, and per-context routing. Local storage is always available as the fallback." })]
		}),
		(0, import_jsx_runtime.jsx)("div", {
			className: "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2",
			children: !isReady || !backends || !preferences || !installMethods ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-1 py-6 text-sm text-muted",
				children: [(0, import_jsx_runtime.jsx)(Loader2, {
					className: "h-4 w-4 animate-spin",
					"aria-hidden": true
				}), " Loading…"]
			}) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [error && (0, import_jsx_runtime.jsx)("div", {
				"aria-live": "polite",
				"data-testid": "vault-modal-error",
				className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger",
				children: error
			}), (0, import_jsx_runtime.jsxs)(Tabs, {
				value: activeTab,
				onValueChange: onTabChange,
				className: "flex min-h-0 flex-1 flex-col",
				children: [(0, import_jsx_runtime.jsxs)(TabsList, {
					className: "h-9 shrink-0 self-start",
					children: [
						(0, import_jsx_runtime.jsx)(TabsTrigger, {
							value: "overview",
							"data-testid": "vault-tab-overview",
							children: "Overview"
						}),
						(0, import_jsx_runtime.jsx)(TabsTrigger, {
							value: "secrets",
							"data-testid": "vault-tab-secrets",
							children: "Secrets"
						}),
						(0, import_jsx_runtime.jsx)(TabsTrigger, {
							value: "logins",
							"data-testid": "vault-tab-logins",
							children: "Logins"
						}),
						(0, import_jsx_runtime.jsx)(TabsTrigger, {
							value: "routing",
							"data-testid": "vault-tab-routing",
							children: "Routing"
						})
					]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-2 min-h-0 flex-1 overflow-y-auto pr-1",
					children: [
						(0, import_jsx_runtime.jsx)(TabsContent, {
							value: "overview",
							className: "mt-0",
							"data-testid": "vault-tab-overview-content",
							children: (0, import_jsx_runtime.jsx)(OverviewTab, {
								backends,
								preferences,
								installMethods,
								saving,
								savedAt,
								onPreferencesChange: setPreferences,
								onSave: () => void save(),
								onReload: () => void load(),
								onInstallComplete: () => void load(),
								onSigninComplete: () => void load(),
								onSignout: (id) => void onSignout(id)
							})
						}),
						(0, import_jsx_runtime.jsx)(TabsContent, {
							value: "secrets",
							className: "mt-0",
							"data-testid": "vault-tab-secrets-content",
							children: (0, import_jsx_runtime.jsx)(SecretsTab, {
								entries: entries ?? [],
								onChanged: () => void refreshInventory(),
								navigate,
								focusKey: activeTab === "secrets" ? focusKey : null,
								focusProfileId: activeTab === "secrets" ? focusProfileId : null,
								onFocusApplied: clearFocusState
							})
						}),
						(0, import_jsx_runtime.jsx)(TabsContent, {
							value: "logins",
							className: "mt-0",
							"data-testid": "vault-tab-logins-content",
							children: (0, import_jsx_runtime.jsx)(LoginsTab, {})
						}),
						(0, import_jsx_runtime.jsx)(TabsContent, {
							value: "routing",
							className: "mt-0",
							"data-testid": "vault-tab-routing-content",
							children: (0, import_jsx_runtime.jsx)(RoutingTab, {
								config: routingConfig ?? { rules: [] },
								agents,
								apps,
								entries: entries ?? [],
								onConfigChange: setRoutingConfig,
								navigate,
								focusKey: activeTab === "routing" ? focusKey : null,
								onFocusApplied: clearFocusState
							})
						})
					]
				})]
			})] })
		}),
		(0, import_jsx_runtime.jsxs)(DialogFooter, {
			className: "flex shrink-0 flex-row items-center justify-between gap-3 border-t border-border/30 pt-3 sm:justify-between",
			children: [(0, import_jsx_runtime.jsx)("p", {
				className: "text-2xs text-muted sm:max-w-sm",
				children: "Non-sensitive config always stays in-house."
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "flex shrink-0 items-center gap-2",
				children: (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "h-9 rounded-lg",
					onClick: () => onOpenChange(false),
					disabled: saving,
					children: "Close"
				})
			})]
		})
	] });
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/shared/LanguageDropdown.js
/** Language metadata with flag emoji and native label. */
const LANGUAGES = [
	{
		id: "en",
		flag: "🇺🇸",
		label: "English"
	},
	{
		id: "zh-CN",
		flag: "🇨🇳",
		label: "中文"
	},
	{
		id: "ko",
		flag: "🇰🇷",
		label: "한국어"
	},
	{
		id: "es",
		flag: "🇪🇸",
		label: "Español"
	},
	{
		id: "pt",
		flag: "🇧🇷",
		label: "Português"
	},
	{
		id: "vi",
		flag: "🇻🇳",
		label: "Tiếng Việt"
	},
	{
		id: "tl",
		flag: "🇵🇭",
		label: "Tagalog"
	}
];
const LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME = "!h-11 !min-h-11 !rounded-xl !px-3.5";
function LanguageDropdown({ uiLanguage, setUiLanguage, t, className, triggerClassName, variant = "native", menuPlacement = "bottom-end" }) {
	const [open, setOpen] = useState(false);
	const current = LANGUAGES.find((l) => l.id === uiLanguage) ?? LANGUAGES[0];
	const triggerClassNameResolved = variant === "titlebar" ? `inline-flex h-[2.375rem] min-h-[2.375rem] min-w-0 items-center justify-center rounded-md border border-transparent !bg-transparent px-2.5 py-0 text-[11px] font-medium text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent data-[state=open]:!bg-transparent ${open ? "text-accent" : ""} ${triggerClassName ?? ""}` : `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-xl px-3.5 py-0 border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt gap-1.5 text-xs font-medium ${open ? "border-accent/80 bg-accent/12 text-txt shadow-md" : ""} ${triggerClassName ?? ""}`;
	const contentClassName = variant === "titlebar" ? "w-40 overflow-hidden rounded-xl border border-border/70 bg-card/96 py-1 shadow-[0_18px_36px_rgba(2,8,23,0.24)] backdrop-blur-xl" : "w-40 overflow-hidden rounded-xl border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-xl";
	return (0, import_jsx_runtime.jsx)("div", {
		className: `relative inline-flex shrink-0 ${className ?? ""}`,
		"data-testid": "language-dropdown",
		"data-no-camera-drag": "true",
		children: (0, import_jsx_runtime.jsxs)(DropdownMenu, {
			open,
			onOpenChange: setOpen,
			children: [(0, import_jsx_runtime.jsx)(DropdownMenuTrigger, {
				asChild: true,
				children: (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					className: triggerClassNameResolved,
					onPointerDown: (event) => event.stopPropagation(),
					"aria-label": t?.("settings.language") ?? "Language",
					"data-testid": "language-dropdown-trigger",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "text-sm leading-none",
							children: current.flag
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: variant === "titlebar" ? "uppercase tracking-[0.14em] opacity-80" : "hidden sm:inline uppercase tracking-widest opacity-80",
							children: current.id
						}),
						(0, import_jsx_runtime.jsx)(ChevronDown, { className: `w-3.5 h-3.5 opacity-60 transition-transform ${open ? "rotate-180" : ""}` })
					]
				})
			}), (0, import_jsx_runtime.jsx)(DropdownMenuContent, {
				align: "end",
				side: menuPlacement === "top-end" ? "top" : "bottom",
				sideOffset: 4,
				className: contentClassName,
				style: variant === "companion" ? {
					zIndex: 10001,
					backdropFilter: "blur(24px)",
					WebkitBackdropFilter: "blur(24px)",
					boxShadow: "var(--shadow-lg)"
				} : void 0,
				"data-no-camera-drag": "true",
				children: LANGUAGES.map((lang) => (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
					className: `flex min-h-[40px] items-center justify-between px-3 py-2 text-sm transition-colors cursor-pointer ${lang.id === uiLanguage ? "bg-accent/10 text-txt font-medium" : "text-txt"}`,
					onPointerDown: (event) => event.stopPropagation(),
					onSelect: () => {
						setUiLanguage(lang.id);
					},
					"data-testid": `language-option-${lang.id}`,
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("span", { children: lang.flag }), (0, import_jsx_runtime.jsx)("span", { children: lang.label })]
					}), lang.id === uiLanguage && (0, import_jsx_runtime.jsx)(Check, { className: "w-4 h-4" })]
				}, lang.id))
			})]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/character/character-voice-config.js
/**
* Voice-related constants and helpers extracted from CharacterEditor.
*/
const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_VOICE_GROUPS = [
	{
		labelKey: "charactereditor.VoiceGroupFemale",
		defaultLabel: "Female",
		items: PREMADE_VOICES.filter((p) => p.gender === "female").map((p) => ({
			id: p.id,
			text: p.name
		}))
	},
	{
		labelKey: "charactereditor.VoiceGroupMale",
		defaultLabel: "Male",
		items: PREMADE_VOICES.filter((p) => p.gender === "male").map((p) => ({
			id: p.id,
			text: p.name
		}))
	},
	{
		labelKey: "charactereditor.VoiceGroupCharacter",
		defaultLabel: "Character",
		items: PREMADE_VOICES.filter((p) => p.gender === "character").map((p) => ({
			id: p.id,
			text: p.name
		}))
	}
];
const EDGE_VOICE_GROUPS = [{
	labelKey: "charactereditor.BackupVoices",
	defaultLabel: "Backup Voices",
	items: EDGE_BACKUP_VOICES.map((p) => ({
		id: p.id,
		text: p.name
	}))
}];
function buildVoiceConfigForCharacterEntry(args) {
	const presetVoice = args.entry.voicePresetId ? PREMADE_VOICES.find((preset) => preset.id === args.entry.voicePresetId) : void 0;
	if (!presetVoice) return null;
	if (args.useElevenLabs) {
		const existingElevenlabs = typeof args.voiceConfig.elevenlabs === "object" ? args.voiceConfig.elevenlabs : {};
		const defaultVoiceMode = typeof args.voiceConfig.mode === "string" ? args.voiceConfig.mode : hasConfiguredApiKey(existingElevenlabs.apiKey) ? "own-key" : "cloud";
		const nextVoiceConfig = {
			...args.voiceConfig,
			provider: "elevenlabs",
			mode: defaultVoiceMode,
			elevenlabs: {
				...existingElevenlabs,
				voiceId: presetVoice.voiceId,
				modelId: existingElevenlabs.modelId ?? DEFAULT_ELEVEN_FAST_MODEL
			}
		};
		return {
			nextVoiceConfig,
			persistedVoiceConfig: nextVoiceConfig,
			selectedVoicePresetId: presetVoice.id
		};
	}
	const edgeGender = presetVoice.gender === "male" ? "edge-male" : "edge-female";
	const edgeVoice = EDGE_BACKUP_VOICES.find((voice) => voice.id === edgeGender);
	if (!edgeVoice) return null;
	const existingEdge = typeof args.voiceConfig.edge === "object" ? args.voiceConfig.edge : {};
	const nextVoiceConfig = {
		...args.voiceConfig,
		provider: "edge",
		edge: {
			...existingEdge,
			voice: edgeVoice.voiceId
		}
	};
	return {
		nextVoiceConfig,
		persistedVoiceConfig: nextVoiceConfig,
		selectedVoicePresetId: edgeVoice.id
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/config-page-sections.js
/**
* Sub-components and helpers for ConfigPageView.
* Extracted from ConfigPageView.tsx.
*/
const EVM_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.evm;
const BSC_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.bsc;
const SOLANA_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.solana;
function CloudRpcStatus({ connected, loginBusy, onLogin }) {
	const { t } = useApp();
	if (connected) return null;
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex justify-start",
		children: (0, import_jsx_runtime.jsx)(Button, {
			variant: "default",
			size: "sm",
			className: "text-xs font-bold",
			onClick: () => void onLogin(),
			disabled: loginBusy,
			children: loginBusy ? t("game.connecting", { defaultValue: "Connecting..." }) : t("elizaclouddashboard.ConnectElizaCloud", { defaultValue: "Connect to Eliza Cloud" })
		})
	});
}
function buildRpcRendererConfig(t, selectedProvider, providerConfigs, rpcFieldValues) {
	const fields = providerConfigs[selectedProvider];
	if (!fields?.length) return null;
	const props = {
		schema: {
			type: "object",
			properties: {},
			required: []
		},
		hints: {},
		values: {},
		setKeys: /* @__PURE__ */ new Set()
	};
	for (const field of fields) {
		props.schema.properties[field.configKey] = {
			type: "string",
			description: field.label
		};
		props.hints[field.configKey] = {
			label: field.label,
			sensitive: true,
			placeholder: field.isSet ? t("configpageview.ApiKeySetPlaceholder", { defaultValue: "Already set — leave blank to keep" }) : t("configpageview.ApiKeyPlaceholder", { defaultValue: "Enter API key" }),
			width: "full"
		};
		if (rpcFieldValues[field.configKey] !== void 0) props.values[field.configKey] = rpcFieldValues[field.configKey];
		if (field.isSet) props.setKeys.add(field.configKey);
	}
	return props;
}
function RpcConfigSection({ title, description, options, selectedProvider, onSelect, providerConfigs, rpcFieldValues, onRpcFieldChange, cloud, containerClassName, t }) {
	const rpcConfig = buildRpcRendererConfig(t, selectedProvider, providerConfigs, rpcFieldValues);
	return (0, import_jsx_runtime.jsxs)("div", { children: [
		(0, import_jsx_runtime.jsx)("div", {
			className: "text-xs font-bold mb-1",
			children: title
		}),
		(0, import_jsx_runtime.jsx)("div", {
			className: "text-xs-tight text-muted mb-2",
			children: description
		}),
		renderRpcProviderButtons(options, selectedProvider, onSelect, containerClassName, (key) => {
			return key === "providerswitcher.elizaCloud" ? t("common.cloud", { defaultValue: "Eliza Cloud" }) : key;
		}),
		(0, import_jsx_runtime.jsx)("div", {
			className: "mt-3",
			children: selectedProvider === "eliza-cloud" ? (0, import_jsx_runtime.jsx)(CloudRpcStatus, {
				connected: cloud.connected,
				loginBusy: cloud.loginBusy,
				onLogin: () => void cloud.onLogin()
			}) : rpcConfig ? (0, import_jsx_runtime.jsx)(ConfigRenderer, {
				schema: rpcConfig.schema,
				hints: rpcConfig.hints,
				values: rpcConfig.values,
				setKeys: rpcConfig.setKeys,
				registry: defaultRegistry,
				onChange: onRpcFieldChange
			}) : null
		})
	] });
}
function renderRpcProviderButtons(options, selectedProvider, onSelect, containerClassName, tFallback) {
	return (0, import_jsx_runtime.jsx)("div", {
		className: containerClassName,
		children: options.map((provider) => {
			const active = selectedProvider === provider.id;
			return (0, import_jsx_runtime.jsx)(Button, {
				variant: active ? "default" : "outline",
				className: `flex min-h-touch items-center justify-center rounded-lg px-3 py-2 text-center text-xs font-semibold leading-tight shadow-sm ${active ? "" : "border-border bg-card text-txt hover:border-accent hover:bg-bg-hover"}`,
				onClick: () => onSelect(provider.id),
				children: (0, import_jsx_runtime.jsx)("div", {
					className: "leading-tight",
					children: provider.id === "eliza-cloud" && tFallback ? tFallback("providerswitcher.elizaCloud") : provider.label
				})
			}, provider.id);
		})
	});
}
const CLOUD_SERVICE_DEFS = [
	{
		key: "rpc",
		labelKey: "configpageview.ServiceRpcLabel",
		labelDefault: "RPC",
		descriptionKey: "configpageview.ServiceRpcDesc",
		descriptionDefault: "Remote procedure calls for agent coordination and messaging."
	},
	{
		key: "media",
		labelKey: "configpageview.ServiceMediaLabel",
		labelDefault: "Media",
		descriptionKey: "configpageview.ServiceMediaDesc",
		descriptionDefault: "Cloud media processing for images, video, and file conversion."
	},
	{
		key: "tts",
		labelKey: "configpageview.ServiceTtsLabel",
		labelDefault: "Text-to-Speech",
		descriptionKey: "configpageview.ServiceTtsDesc",
		descriptionDefault: "Cloud-hosted voice synthesis for agent speech output."
	},
	{
		key: "embeddings",
		labelKey: "configpageview.ServiceEmbeddingsLabel",
		labelDefault: "Embeddings",
		descriptionKey: "configpageview.ServiceEmbeddingsDesc",
		descriptionDefault: "Cloud-hosted embedding models for knowledge search and memory."
	}
];
function isCloudServiceRouteSelected(route) {
	if (!route || typeof route !== "object" || Array.isArray(route)) return false;
	const routeRecord = route;
	return routeRecord.transport === "cloud-proxy" && normalizeOnboardingProviderId(routeRecord.backend) === "elizacloud";
}
function CloudServicesSection() {
	const { t } = useApp();
	const [services, setServices] = useState({
		rpc: false,
		media: false,
		tts: false,
		embeddings: false
	});
	const [saving, setSaving] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [needsRestart, setNeedsRestart] = useState(false);
	useEffect(() => {
		let cancelled = false;
		client.getConfig().then((cfg) => {
			if (cancelled) return;
			const routing = cfg.serviceRouting && typeof cfg.serviceRouting === "object" && !Array.isArray(cfg.serviceRouting) ? cfg.serviceRouting : {};
			setServices({
				rpc: isCloudServiceRouteSelected(routing.rpc),
				media: isCloudServiceRouteSelected(routing.media),
				tts: isCloudServiceRouteSelected(routing.tts),
				embeddings: isCloudServiceRouteSelected(routing.embeddings)
			});
			setLoaded(true);
		}).catch(() => setLoaded(true));
		return () => {
			cancelled = true;
		};
	}, []);
	const handleToggle = useCallback(async (key) => {
		const newValue = !services[key];
		setServices({
			...services,
			[key]: newValue
		});
		setSaving(true);
		try {
			const cfg = await client.getConfig();
			const existingRouting = cfg.serviceRouting && typeof cfg.serviceRouting === "object" && !Array.isArray(cfg.serviceRouting) ? cfg.serviceRouting : {};
			await client.updateConfig({ serviceRouting: {
				...existingRouting,
				[key]: newValue ? {
					backend: "elizacloud",
					transport: "cloud-proxy",
					accountId: "elizacloud"
				} : null
			} });
			setNeedsRestart(true);
		} catch (err) {
			setServices(services);
			console.error("[config] Failed to save cloud services:", err);
		} finally {
			setSaving(false);
		}
	}, [services]);
	if (!loaded) return null;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-6",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between mb-3",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "text-sm font-semibold",
					children: t("configpageview.CloudServices", { defaultValue: "Cloud Services" })
				}), needsRestart && (0, import_jsx_runtime.jsx)("span", {
					className: "text-xs-tight font-medium px-2.5 py-0.5 rounded-full border border-accent/30 bg-accent/8 text-accent",
					children: t("configpageview.RestartRequired", { defaultValue: "Restart required" })
				})]
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted mb-4 leading-snug",
				children: t("configpageview.CloudServicesDesc", { defaultValue: "Toggle Eliza Cloud services" })
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-col gap-2",
				children: CLOUD_SERVICE_DEFS.map(({ key, labelKey, labelDefault, descriptionKey, descriptionDefault }) => (0, import_jsx_runtime.jsxs)("div", {
					className: `flex items-center justify-between p-3 border border-border rounded-lg transition-colors ${services[key] ? "bg-accent/5" : ""}`,
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex-1 min-w-0 mr-4",
						children: [(0, import_jsx_runtime.jsx)("div", {
							id: `cloud-service-${key}`,
							className: "text-sm font-medium text-txt",
							children: t(labelKey, { defaultValue: labelDefault })
						}), (0, import_jsx_runtime.jsx)("div", {
							className: "text-xs-tight text-muted mt-0.5",
							children: t(descriptionKey, { defaultValue: descriptionDefault })
						})]
					}), (0, import_jsx_runtime.jsx)(Switch, {
						checked: services[key],
						disabled: saving,
						onCheckedChange: () => void handleToggle(key),
						"aria-labelledby": `cloud-service-${key}`
					})]
				}, key))
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/SecretsView.js
const STORAGE_KEY = "eliza:secrets-vault-keys";
const CATEGORY_ORDER = [
	"ai-provider",
	"blockchain",
	"connector",
	"auth",
	"other"
];
const CATEGORY_LABELS = {
	"ai-provider": "AI Providers",
	blockchain: "Blockchain",
	connector: "Connectors",
	auth: "Authentication",
	other: "Other"
};
const fallbackTranslate = (key, vars) => typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
function groupSecretsByCategory(secrets) {
	const grouped = /* @__PURE__ */ new Map();
	for (const secret of secrets) {
		const existing = grouped.get(secret.category);
		if (existing) existing.push(secret);
		else grouped.set(secret.category, [secret]);
	}
	return CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => ({
		category,
		label: CATEGORY_LABELS[category],
		secrets: grouped.get(category) ?? []
	}));
}
function loadPinnedKeys() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return new Set(JSON.parse(raw));
	} catch (err) {
		console.warn("[SecretsView] Failed to load pinned keys from localStorage:", err);
	}
	return /* @__PURE__ */ new Set();
}
function savePinnedKeys(keys) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
	} catch (err) {
		console.warn("[SecretsView] Failed to save pinned keys to localStorage:", err);
	}
}
function SecretsView({ contentHeader, inModal } = {}) {
	const t = useApp()?.t ?? fallbackTranslate;
	const [allSecrets, setAllSecrets] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [pinnedKeys, setPinnedKeys] = useState(loadPinnedKeys);
	const [draft, setDraft] = useState({});
	const [visible, setVisible] = useState(/* @__PURE__ */ new Set());
	const [saving, setSaving] = useState(false);
	const [saveResult, setSaveResult] = useState(null);
	const [collapsed, setCollapsed] = useState(/* @__PURE__ */ new Set());
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerSearch, setPickerSearch] = useState("");
	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setAllSecrets((await client.getSecrets()).secrets);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load secrets");
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	const vaultSecrets = useMemo(() => {
		return allSecrets.filter((s) => pinnedKeys.has(s.key) || s.isSet);
	}, [allSecrets, pinnedKeys]);
	const availableSecrets = useMemo(() => {
		const vaultKeys = new Set(vaultSecrets.map((s) => s.key));
		const available = allSecrets.filter((s) => !vaultKeys.has(s.key));
		if (!pickerSearch.trim()) return available;
		const q = pickerSearch.toLowerCase();
		return available.filter((s) => s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.usedBy.some((u) => u.pluginName.toLowerCase().includes(q)));
	}, [
		allSecrets,
		vaultSecrets,
		pickerSearch
	]);
	const grouped = useMemo(() => {
		return groupSecretsByCategory(vaultSecrets);
	}, [vaultSecrets]);
	const dirtyKeys = useMemo(() => {
		return Object.keys(draft).filter((k) => draft[k].trim() !== "");
	}, [draft]);
	const pinKey = (key) => {
		setPinnedKeys((prev) => {
			const next = new Set(prev);
			next.add(key);
			savePinnedKeys(next);
			return next;
		});
	};
	const unpinKey = (key) => {
		setPinnedKeys((prev) => {
			const next = new Set(prev);
			next.delete(key);
			savePinnedKeys(next);
			return next;
		});
		setDraft((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	};
	const handleSave = async () => {
		if (dirtyKeys.length === 0) return;
		setSaving(true);
		setSaveResult(null);
		try {
			const payload = {};
			for (const key of dirtyKeys) payload[key] = draft[key];
			const res = await client.updateSecrets(payload);
			setSaveResult({
				ok: true,
				message: `Updated ${res.updated.length} secret${res.updated.length !== 1 ? "s" : ""}`
			});
			setDraft({});
			await load();
		} catch (err) {
			setSaveResult({
				ok: false,
				message: err instanceof Error ? err.message : "Save failed"
			});
		} finally {
			setSaving(false);
		}
	};
	const toggleCollapse = (cat) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(cat)) next.delete(cat);
			else next.add(cat);
			return next;
		});
	};
	const toggleVisible = (key) => {
		setVisible((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	if (loading) return (0, import_jsx_runtime.jsx)(ContentLayout, {
		contentHeader,
		inModal,
		children: (0, import_jsx_runtime.jsx)("div", {
			className: "rounded-2xl border border-border/50 bg-card/92 shadow-sm py-8 text-center text-sm italic text-muted",
			children: t("secretsview.LoadingSecrets")
		})
	});
	if (error) return (0, import_jsx_runtime.jsx)(ContentLayout, {
		contentHeader,
		inModal,
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "rounded-2xl border border-border/50 bg-card/92 shadow-sm px-4 py-8 text-center",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "mb-2 text-sm text-danger",
				children: error
			}), (0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-8 px-3 text-sm",
				onClick: load,
				children: t("common.retry")
			})]
		})
	});
	return (0, import_jsx_runtime.jsx)(ContentLayout, {
		contentHeader,
		inModal,
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-5",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
					children: [(0, import_jsx_runtime.jsx)("div", { className: "m-0 max-w-2xl text-sm leading-6 text-muted" }), (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-9 flex-shrink-0 px-3 text-sm shadow-sm",
						onClick: () => {
							setPickerOpen(true);
							setPickerSearch("");
						},
						children: t("secretsview.AddSecret")
					})]
				}),
				pickerOpen && (0, import_jsx_runtime.jsx)(SecretPicker, {
					available: availableSecrets,
					search: pickerSearch,
					onSearchChange: setPickerSearch,
					onAdd: (key) => {
						pinKey(key);
					},
					onClose: () => setPickerOpen(false)
				}),
				vaultSecrets.length === 0 && (0, import_jsx_runtime.jsx)("div", {
					className: "rounded-2xl border border-border/50 bg-card/92 shadow-sm border-dashed px-4 py-8 text-center text-sm italic text-muted",
					children: t("secretsview.YourVaultIsEmpty")
				}),
				grouped.map(({ category, label, secrets: catSecrets }) => (0, import_jsx_runtime.jsxs)("section", {
					className: "space-y-3",
					children: [(0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						className: "mb-3 h-auto w-full items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-left hover:border-border/50 hover:bg-bg-hover",
						onClick: () => toggleCollapse(category),
						"aria-expanded": !collapsed.has(category),
						children: [
							(0, import_jsx_runtime.jsx)(ChevronDown, {
								className: "h-3 w-3 select-none text-muted transition-transform",
								style: { transform: collapsed.has(category) ? "rotate(-90deg)" : "rotate(0deg)" }
							}),
							(0, import_jsx_runtime.jsx)("span", {
								className: "text-sm font-semibold text-txt",
								children: label
							}),
							(0, import_jsx_runtime.jsxs)("span", {
								className: "text-xs text-muted",
								children: [
									"(",
									catSecrets.length,
									")"
								]
							})
						]
					}), !collapsed.has(category) && (0, import_jsx_runtime.jsx)("div", {
						className: "grid grid-cols-1 gap-3 md:grid-cols-2",
						children: catSecrets.map((secret) => (0, import_jsx_runtime.jsx)(SecretCard, {
							secret,
							draftValue: draft[secret.key] ?? "",
							isVisible: visible.has(secret.key),
							isPinned: pinnedKeys.has(secret.key),
							onToggleVisible: () => toggleVisible(secret.key),
							onDraftChange: (val) => setDraft((prev) => ({
								...prev,
								[secret.key]: val
							})),
							onRemove: () => unpinKey(secret.key)
						}, secret.key))
					})]
				}, category)),
				vaultSecrets.length > 0 && (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-2xl border border-border/50 bg-card/92 shadow-sm flex flex-col gap-3 border-border/60 px-4 py-3 sm:flex-row sm:items-center",
					children: [(0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-9 px-4 text-sm font-medium shadow-sm transition-colors",
						disabled: dirtyKeys.length === 0 || saving,
						onClick: handleSave,
						children: saving ? t("common.saving", { defaultValue: "Saving..." }) : dirtyKeys.length > 0 ? `${t("common.save")} (${dirtyKeys.length})` : t("common.save")
					}), saveResult && (0, import_jsx_runtime.jsx)("span", {
						className: `text-sm ${saveResult.ok ? "text-ok" : "text-danger"}`,
						children: saveResult.message
					})]
				})
			]
		})
	});
}
function SecretPicker({ available, search, onSearchChange, onAdd, onClose }) {
	const t = useApp()?.t ?? fallbackTranslate;
	const grouped = useMemo(() => {
		return groupSecretsByCategory(available);
	}, [available]);
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open: true,
		onOpenChange: (open) => {
			if (!open) onClose();
		},
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			showCloseButton: false,
			className: "w-[min(calc(100%_-_2rem),35rem)] max-h-[min(80vh,36rem)] overflow-hidden rounded-2xl border border-border/60 bg-card/96 p-0 shadow-2xl",
			children: [
				(0, import_jsx_runtime.jsxs)(DialogHeader, {
					className: "flex flex-row items-center justify-between px-4 py-3",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)(DialogTitle, {
							className: "text-sm font-semibold text-txt",
							children: t("secretsview.AddSecretsToVault")
						}), (0, import_jsx_runtime.jsx)(DialogDescription, {
							className: "sr-only",
							children: t("secretsview.SearchByKeyDescr")
						})]
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "icon",
						className: "h-8 w-8 rounded-lg text-base text-muted hover:text-txt",
						onClick: onClose,
						"aria-label": t("common.close"),
						children: "x"
					})]
				}),
				(0, import_jsx_runtime.jsx)(Input, {
					type: "text",
					className: "h-12 w-full rounded-none border-0 bg-transparent px-4 py-2.5 text-sm text-txt shadow-none focus-visible:ring-0 font-body",
					placeholder: t("secretsview.SearchByKeyDescr"),
					"aria-label": t("secretsview.SearchByKeyDescr"),
					value: search,
					onChange: (e) => onSearchChange(e.target.value),
					autoFocus: true
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "flex-1 overflow-y-auto p-3",
					children: available.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-xl border border-dashed border-border/60 py-6 text-center text-sm text-muted",
						children: search ? "No matching secrets found." : "All available secrets are already in your vault."
					}) : grouped.map(({ category, label, secrets }) => (0, import_jsx_runtime.jsxs)("div", {
						className: "mb-4 space-y-2",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "text-xs-tight font-semibold uppercase tracking-wide text-muted",
							children: label
						}), secrets.map((s) => {
							const enabledPlugins = s.usedBy.filter((u) => u.enabled);
							const pluginList = s.usedBy.map((u) => u.pluginName || u.pluginId).join(", ");
							return (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-start justify-between gap-3 rounded-xl border border-transparent px-3 py-2 hover:border-border/40 hover:bg-bg-hover",
								children: [(0, import_jsx_runtime.jsxs)("div", {
									className: "flex-1 min-w-0",
									children: [(0, import_jsx_runtime.jsx)("div", {
										className: "truncate text-sm font-mono text-txt",
										children: s.key
									}), (0, import_jsx_runtime.jsxs)("div", {
										className: "text-xs-tight leading-5 text-muted",
										title: pluginList,
										children: [s.description, s.usedBy.length > 0 && (0, import_jsx_runtime.jsxs)("span", {
											className: "ml-1",
											children: [
												"—",
												" ",
												enabledPlugins.length > 0 ? `${enabledPlugins.length} active plugin${enabledPlugins.length !== 1 ? "s" : ""}` : `${s.usedBy.length} plugin${s.usedBy.length !== 1 ? "s" : ""} (none active)`
											]
										})]
									})]
								}), (0, import_jsx_runtime.jsx)(Button, {
									variant: "default",
									size: "sm",
									className: "px-2.5 py-1 h-7 text-xs shadow-sm flex-shrink-0",
									onClick: () => onAdd(s.key),
									children: t("common.add")
								})]
							}, s.key);
						})]
					}, category))
				})
			]
		})
	});
}
function SecretCard({ secret, draftValue, isVisible, isPinned, onToggleVisible, onDraftChange, onRemove }) {
	const t = useApp()?.t ?? fallbackTranslate;
	const enabledPlugins = secret.usedBy.filter((u) => u.enabled);
	const pluginList = secret.usedBy.map((u) => u.pluginName || u.pluginId).join(", ");
	const hasDraft = draftValue.trim() !== "";
	const showRequired = secret.required && enabledPlugins.length > 0;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-2xl border border-border/50 bg-card/92 shadow-sm flex flex-col gap-3 p-4",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start justify-between gap-2",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "flex-1 min-w-0",
					children: (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "h-2 w-2 flex-shrink-0 rounded-full",
							style: { backgroundColor: secret.isSet ? "var(--ok)" : "var(--muted)" }
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "truncate text-sm font-mono font-medium text-txt",
							children: secret.key
						})]
					})
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-shrink-0 items-center gap-1.5",
					children: [showRequired && (0, import_jsx_runtime.jsx)("span", {
						className: "rounded border border-danger/35 bg-danger/10 px-1.5 py-0.5 text-2xs font-medium text-danger",
						children: t("secretsview.Required")
					}), isPinned && !secret.isSet && (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-7 rounded-md px-2 text-xs-tight text-muted hover:bg-danger/10 hover:text-danger",
						onClick: onRemove,
						title: t("secretsview.RemoveFromVault"),
						children: "x"
					})]
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "break-words text-xs-tight leading-5 text-muted",
				title: pluginList,
				children: enabledPlugins.length > 0 ? `Used by ${enabledPlugins.length} active plugin${enabledPlugins.length !== 1 ? "s" : ""}: ${enabledPlugins.map((u) => u.pluginName || u.pluginId).join(", ")}` : `Available for: ${pluginList}`
			}),
			secret.isSet && !hasDraft && (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-lg border border-border/50 bg-bg px-2 py-1 text-xs font-mono text-muted",
				children: secret.maskedValue
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col items-stretch gap-2 sm:flex-row sm:items-center",
				children: [(0, import_jsx_runtime.jsx)(Input, {
					type: isVisible ? "text" : "password",
					className: "h-9 flex-1 border-border/60 bg-bg px-2.5 py-1.5 text-sm font-mono text-txt focus-visible:border-accent/50 focus-visible:ring-1 focus-visible:ring-accent/30",
					placeholder: secret.isSet ? "Enter new value to update" : "Enter value",
					value: draftValue,
					onChange: (e) => onDraftChange(e.target.value)
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-9 px-3 text-xs text-muted-strong shadow-sm hover:text-txt",
					onClick: onToggleVisible,
					title: isVisible ? "Hide" : "Show",
					children: isVisible ? "Hide" : "Show"
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ConfigPageView.js
const CLOUD_RPC_SELECTIONS = {
	evm: "eliza-cloud",
	bsc: "eliza-cloud",
	solana: "eliza-cloud"
};
function areCloudRpcSelections(selections) {
	return selections.evm === "eliza-cloud" && selections.bsc === "eliza-cloud" && selections.solana === "eliza-cloud";
}
function ConfigPageView({ embedded = false, onWalletSaveSuccess }) {
	const { t, elizaCloudConnected, elizaCloudLoginBusy, walletConfig, walletApiKeySaving, handleWalletApiKeySave, handleCloudLogin } = useApp();
	const [secretsOpen, setSecretsOpen] = useState(false);
	const manualRpcModeSelection = useRef(false);
	const initialRpc = resolveInitialWalletRpcSelections(walletConfig);
	const initialEvmRpc = initialRpc.evm;
	const initialBscRpc = initialRpc.bsc;
	const initialSolanaRpc = initialRpc.solana;
	const allCloud = areCloudRpcSelections(initialRpc) || !walletConfig && elizaCloudConnected;
	const [rpcMode, setRpcMode] = useState(allCloud ? "cloud" : "custom");
	const [rpcFieldValues, setRpcFieldValues] = useState({});
	const handleRpcFieldChange = useCallback((key, value) => {
		setRpcFieldValues((prev) => ({
			...prev,
			[key]: String(value ?? "")
		}));
	}, []);
	const initialSelectedRpc = allCloud ? CLOUD_RPC_SELECTIONS : initialRpc;
	const [selectedEvmRpc, setSelectedEvmRpc] = useState(initialSelectedRpc.evm);
	const [selectedBscRpc, setSelectedBscRpc] = useState(initialSelectedRpc.bsc);
	const [selectedSolanaRpc, setSelectedSolanaRpc] = useState(initialSelectedRpc.solana);
	useEffect(() => {
		if (manualRpcModeSelection.current) return;
		const selections = {
			evm: initialEvmRpc,
			bsc: initialBscRpc,
			solana: initialSolanaRpc
		};
		const nextMode = areCloudRpcSelections(selections) ? "cloud" : "custom";
		setRpcMode(nextMode);
		if (nextMode === "cloud") {
			setSelectedEvmRpc(CLOUD_RPC_SELECTIONS.evm);
			setSelectedBscRpc(CLOUD_RPC_SELECTIONS.bsc);
			setSelectedSolanaRpc(CLOUD_RPC_SELECTIONS.solana);
		} else {
			setSelectedEvmRpc(selections.evm);
			setSelectedBscRpc(selections.bsc);
			setSelectedSolanaRpc(selections.solana);
		}
	}, [
		initialBscRpc,
		initialEvmRpc,
		initialSolanaRpc
	]);
	const handleModeChange = useCallback((mode) => {
		manualRpcModeSelection.current = true;
		setRpcMode(mode);
		if (mode === "cloud") {
			setSelectedEvmRpc(CLOUD_RPC_SELECTIONS.evm);
			setSelectedBscRpc(CLOUD_RPC_SELECTIONS.bsc);
			setSelectedSolanaRpc(CLOUD_RPC_SELECTIONS.solana);
		}
	}, []);
	const handleWalletSaveAll = useCallback(async () => {
		if (await handleWalletApiKeySave(buildWalletRpcUpdateRequest({
			walletConfig,
			rpcFieldValues,
			selectedProviders: {
				evm: selectedEvmRpc,
				bsc: selectedBscRpc,
				solana: selectedSolanaRpc
			}
		}))) onWalletSaveSuccess?.();
	}, [
		handleWalletApiKeySave,
		onWalletSaveSuccess,
		rpcFieldValues,
		selectedBscRpc,
		selectedEvmRpc,
		selectedSolanaRpc,
		walletConfig
	]);
	const evmRpcConfigs = {
		alchemy: [{
			configKey: "ALCHEMY_API_KEY",
			label: t("onboarding.rpcAlchemyKey", { defaultValue: "Alchemy API Key" }),
			isSet: walletConfig?.alchemyKeySet ?? false
		}],
		infura: [{
			configKey: "INFURA_API_KEY",
			label: t("configpageview.InfuraApiKey", { defaultValue: "Infura API Key" }),
			isSet: walletConfig?.infuraKeySet ?? false
		}],
		ankr: [{
			configKey: "ANKR_API_KEY",
			label: t("configpageview.AnkrApiKey", { defaultValue: "Ankr API Key" }),
			isSet: walletConfig?.ankrKeySet ?? false
		}]
	};
	const bscRpcConfigs = {
		alchemy: [{
			configKey: "ALCHEMY_API_KEY",
			label: t("onboarding.rpcAlchemyKey", { defaultValue: "Alchemy API Key" }),
			isSet: walletConfig?.alchemyKeySet ?? false
		}],
		ankr: [{
			configKey: "ANKR_API_KEY",
			label: t("configpageview.AnkrApiKey", { defaultValue: "Ankr API Key" }),
			isSet: walletConfig?.ankrKeySet ?? false
		}],
		nodereal: [{
			configKey: "NODEREAL_BSC_RPC_URL",
			label: t("configpageview.NodeRealBscRpcUrl", { defaultValue: "NodeReal BSC RPC URL" }),
			isSet: walletConfig?.nodeRealBscRpcSet ?? false
		}],
		quicknode: [{
			configKey: "QUICKNODE_BSC_RPC_URL",
			label: t("configpageview.QuickNodeBscRpcUrl", { defaultValue: "QuickNode BSC RPC URL" }),
			isSet: walletConfig?.quickNodeBscRpcSet ?? false
		}]
	};
	const solanaRpcConfigs = { "helius-birdeye": [{
		configKey: "HELIUS_API_KEY",
		label: t("configpageview.HeliusApiKey", { defaultValue: "Helius API Key" }),
		isSet: walletConfig?.heliusKeySet ?? false
	}, {
		configKey: "BIRDEYE_API_KEY",
		label: t("configpageview.BirdeyeApiKey", { defaultValue: "Birdeye API Key" }),
		isSet: walletConfig?.birdeyeKeySet ?? false
	}] };
	const cloudStatusProps = {
		connected: elizaCloudConnected,
		loginBusy: elizaCloudLoginBusy,
		onLogin: () => void handleCloudLogin(preOpenWindow())
	};
	const legacyRpcChains = walletConfig?.legacyCustomChains ?? [];
	const legacyRpcWarning = legacyRpcChains.length > 0 ? t("configpageview.LegacyRawRpcWarning", {
		defaultValue: "Legacy raw RPC is still active for {{chains}}. Re-save a supported provider selection to migrate fully.",
		chains: legacyRpcChains.join(", ")
	}) : null;
	const filterCloudOption = (options) => options.filter((o) => o.id !== "eliza-cloud");
	return (0, import_jsx_runtime.jsxs)("div", { children: [
		!embedded && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("h2", {
			className: "text-lg font-bold mb-1",
			children: t("configpageview.Config")
		}), (0, import_jsx_runtime.jsx)("p", {
			className: "text-sm text-muted mb-5",
			children: t("configpageview.WalletProvidersAnd")
		})] }),
		(0, import_jsx_runtime.jsxs)("div", {
			className: "grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5",
			children: [(0, import_jsx_runtime.jsxs)(Button, {
				variant: "ghost",
				"data-testid": "wallet-rpc-mode-cloud",
				onClick: () => handleModeChange("cloud"),
				className: `relative flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all h-auto !whitespace-normal ${rpcMode === "cloud" ? "border-accent bg-accent/8 shadow-[0_0_20px_rgba(var(--accent-rgb),0.1)]" : "border-border/40 bg-card/30 opacity-50 grayscale hover:opacity-70 hover:grayscale-0"}`,
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsxs)("svg", {
							width: "18",
							height: "18",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							className: rpcMode === "cloud" ? "text-accent" : "text-muted",
							children: [(0, import_jsx_runtime.jsx)("title", { children: t("configpageview.CloudModeSvgTitle", { defaultValue: "Eliza Cloud managed RPC" }) }), (0, import_jsx_runtime.jsx)("path", { d: "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" })]
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "text-sm font-bold",
							children: t("common.elizaCloud", { defaultValue: "Eliza Cloud" })
						})]
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight text-muted leading-snug",
						children: t("configpageview.CloudModeDesc", { defaultValue: "Managed RPC for EVM, BSC, and Solana via Eliza Cloud, with Helius on Solana." })
					}),
					rpcMode === "cloud" && (0, import_jsx_runtime.jsx)("span", {
						className: "absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-2xs font-bold text-accent-fg",
						children: "✓"
					})
				]
			}), (0, import_jsx_runtime.jsxs)(Button, {
				variant: "ghost",
				onClick: () => handleModeChange("custom"),
				className: `relative flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all h-auto !whitespace-normal ${rpcMode === "custom" ? "border-accent bg-accent/8 shadow-[0_0_20px_rgba(var(--accent-rgb),0.1)]" : "border-border/40 bg-card/30 opacity-50 grayscale hover:opacity-70 hover:grayscale-0"}`,
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsxs)("svg", {
							width: "18",
							height: "18",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round",
							strokeLinejoin: "round",
							className: rpcMode === "custom" ? "text-accent" : "text-muted",
							children: [(0, import_jsx_runtime.jsx)("title", { children: t("configpageview.CustomModeSvgTitle", { defaultValue: "Custom RPC configuration" }) }), (0, import_jsx_runtime.jsx)("path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" })]
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "text-sm font-bold",
							children: t("configpageview.CustomModeTitle", { defaultValue: "Custom RPC" })
						})]
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight text-muted leading-snug",
						children: t("configpageview.CustomModeDesc", { defaultValue: "Bring your own API keys. Configure per chain." })
					}),
					rpcMode === "custom" && (0, import_jsx_runtime.jsx)("span", {
						className: "absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-2xs font-bold text-accent-fg",
						children: "✓"
					})
				]
			})]
		}),
		rpcMode === "cloud" && (0, import_jsx_runtime.jsxs)("div", { children: [elizaCloudConnected ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("div", {
			className: "space-y-2",
			children: [
				{
					label: "EVM",
					desc: t("configpageview.EVMDesc", { defaultValue: "Ethereum, Base, Arbitrum" })
				},
				{
					label: "BSC",
					desc: t("configpageview.BSCDesc", { defaultValue: "BNB Smart Chain" })
				},
				{
					label: "Solana",
					desc: t("configpageview.SolanaDesc", { defaultValue: "Solana mainnet" })
				}
			].map((chain) => (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-3 px-3 py-2.5 rounded-lg bg-bg/50",
				children: [
					(0, import_jsx_runtime.jsx)("span", { className: "w-1.5 h-1.5 rounded-full bg-ok shrink-0" }),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-xs font-semibold text-txt",
						children: chain.label
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight text-muted",
						children: chain.desc
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs text-accent ml-auto font-medium",
						children: t("common.elizaCloud", { defaultValue: "Eliza Cloud" })
					})
				]
			}, chain.label))
		}), !embedded ? (0, import_jsx_runtime.jsx)(CloudServicesSection, {}) : null] }) : (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col items-center gap-4 py-8 text-center",
			children: [
				(0, import_jsx_runtime.jsxs)("svg", {
					width: "40",
					height: "40",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					className: "text-muted",
					children: [(0, import_jsx_runtime.jsx)("title", { children: t("configpageview.CloudLoginRequiredSvgTitle", { defaultValue: "Eliza Cloud login required" }) }), (0, import_jsx_runtime.jsx)("path", { d: "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" })]
				}),
				(0, import_jsx_runtime.jsx)("div", { children: (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm font-semibold text-txt mb-1",
					children: t("elizaclouddashboard.ConnectElizaCloud", { defaultValue: "Connect to Eliza Cloud" })
				}) }),
				(0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					className: "text-xs font-bold",
					onClick: () => void handleCloudLogin(preOpenWindow()),
					disabled: elizaCloudLoginBusy,
					children: elizaCloudLoginBusy ? t("game.connecting", { defaultValue: "Connecting..." }) : t("elizaclouddashboard.ConnectElizaCloud", { defaultValue: "Connect to Eliza Cloud" })
				})
			]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "flex justify-end mt-4",
			children: (0, import_jsx_runtime.jsx)(Button, {
				variant: "default",
				size: "sm",
				"data-testid": "wallet-rpc-save",
				className: "text-xs-tight",
				onClick: () => {
					handleWalletSaveAll();
				},
				disabled: walletApiKeySaving,
				children: walletApiKeySaving ? t("common.saving") : t("common.save")
			})
		})] }),
		rpcMode === "custom" && (0, import_jsx_runtime.jsxs)("div", { children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between mb-4",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "font-bold text-sm",
					children: t("configpageview.CustomRpcProviders", { defaultValue: "Custom RPC Providers" })
				}), (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)] flex items-center gap-1.5 text-xs text-muted hover:text-txt",
					onClick: () => setSecretsOpen(true),
					children: [(0, import_jsx_runtime.jsxs)("svg", {
						width: "13",
						height: "13",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [
							(0, import_jsx_runtime.jsx)("title", { children: t("configpageview.Secrets", { defaultValue: "Secrets" }) }),
							(0, import_jsx_runtime.jsx)("rect", {
								x: "3",
								y: "11",
								width: "18",
								height: "11",
								rx: "2",
								ry: "2"
							}),
							(0, import_jsx_runtime.jsx)("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
						]
					}), t("configpageview.Secrets", { defaultValue: "Secrets" })]
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-5",
				children: [
					(0, import_jsx_runtime.jsx)(RpcConfigSection, {
						title: t("configpageview.EVM", { defaultValue: "EVM" }),
						description: t("configpageview.EVMDesc", { defaultValue: "Ethereum, Base, Arbitrum" }),
						options: filterCloudOption(EVM_RPC_OPTIONS),
						selectedProvider: selectedEvmRpc === "eliza-cloud" ? EVM_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")?.id ?? selectedEvmRpc : selectedEvmRpc,
						onSelect: (provider) => setSelectedEvmRpc(provider),
						providerConfigs: evmRpcConfigs,
						rpcFieldValues,
						onRpcFieldChange: handleRpcFieldChange,
						cloud: cloudStatusProps,
						containerClassName: "flex flex-wrap gap-1.5",
						t
					}),
					(0, import_jsx_runtime.jsx)("div", { className: "py-1" }),
					(0, import_jsx_runtime.jsx)(RpcConfigSection, {
						title: t("configpageview.BSC", { defaultValue: "BSC" }),
						description: t("configpageview.BSCDesc", { defaultValue: "BNB Smart Chain" }),
						options: filterCloudOption(BSC_RPC_OPTIONS),
						selectedProvider: selectedBscRpc === "eliza-cloud" ? BSC_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")?.id ?? selectedBscRpc : selectedBscRpc,
						onSelect: (provider) => setSelectedBscRpc(provider),
						providerConfigs: bscRpcConfigs,
						rpcFieldValues,
						onRpcFieldChange: handleRpcFieldChange,
						cloud: cloudStatusProps,
						containerClassName: "flex flex-wrap gap-1.5",
						t
					}),
					(0, import_jsx_runtime.jsx)("div", { className: "py-1" }),
					(0, import_jsx_runtime.jsx)(RpcConfigSection, {
						title: t("configpageview.Solana", { defaultValue: "Solana" }),
						description: t("configpageview.SolanaDesc", { defaultValue: "Solana mainnet" }),
						options: filterCloudOption(SOLANA_RPC_OPTIONS),
						selectedProvider: selectedSolanaRpc === "eliza-cloud" ? SOLANA_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")?.id ?? selectedSolanaRpc : selectedSolanaRpc,
						onSelect: (provider) => setSelectedSolanaRpc(provider),
						providerConfigs: solanaRpcConfigs,
						rpcFieldValues,
						onRpcFieldChange: handleRpcFieldChange,
						cloud: cloudStatusProps,
						containerClassName: "flex flex-wrap gap-1.5",
						t
					})
				]
			}),
			legacyRpcWarning && (0, import_jsx_runtime.jsx)("div", {
				className: "mt-4 rounded-lg border border-warn bg-warn-subtle px-3 py-2 text-xs-tight text-txt",
				children: legacyRpcWarning
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex justify-end mt-4",
				children: (0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					"data-testid": "wallet-rpc-save",
					className: "text-xs-tight",
					onClick: () => {
						handleWalletSaveAll();
					},
					disabled: walletApiKeySaving,
					children: walletApiKeySaving ? t("common.saving") : t("common.save")
				})
			})
		] }),
		(0, import_jsx_runtime.jsx)(Dialog, {
			open: secretsOpen,
			onOpenChange: setSecretsOpen,
			children: (0, import_jsx_runtime.jsx)(DialogContent, {
				showCloseButton: false,
				className: "w-[min(calc(100%_-_2rem),42rem)] max-h-[min(88vh,48rem)] overflow-hidden rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl",
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "flex max-h-[min(88vh,48rem)] flex-col",
					children: [(0, import_jsx_runtime.jsxs)(DialogHeader, {
						className: "flex flex-row items-center justify-between px-5 py-4",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2",
							children: [(0, import_jsx_runtime.jsxs)("svg", {
								width: "15",
								height: "15",
								viewBox: "0 0 24 24",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: "2",
								strokeLinecap: "round",
								strokeLinejoin: "round",
								className: "text-accent",
								children: [
									(0, import_jsx_runtime.jsx)("title", { children: t("configpageview.SecretsVault") }),
									(0, import_jsx_runtime.jsx)("rect", {
										x: "3",
										y: "11",
										width: "18",
										height: "11",
										rx: "2",
										ry: "2"
									}),
									(0, import_jsx_runtime.jsx)("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
								]
							}), (0, import_jsx_runtime.jsx)(DialogTitle, {
								className: "text-sm font-bold",
								children: t("configpageview.SecretsVault1")
							})]
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							size: "icon",
							className: "text-muted hover:text-txt text-lg leading-none",
							onClick: () => setSecretsOpen(false),
							"aria-label": t("common.close"),
							children: t("bugreportmodal.Times")
						})]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "flex-1 min-h-0 overflow-y-auto p-5",
						children: (0, import_jsx_runtime.jsx)(SecretsView, {})
					})]
				})
			})
		})
	] });
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/cloud/StripeEmbeddedCheckout.js
let stripeLoader = null;
async function loadStripeFactory() {
	if (typeof window === "undefined") throw new Error("Stripe embedded checkout requires a browser environment.");
	if (typeof window.Stripe === "function") return window.Stripe;
	if (stripeLoader) return stripeLoader;
	stripeLoader = new Promise((resolve, reject) => {
		const existing = document.querySelector("script[data-eliza-stripe-loader=\"true\"]");
		if (existing) {
			existing.addEventListener("load", () => {
				if (typeof window.Stripe === "function") resolve(window.Stripe);
				else reject(/* @__PURE__ */ new Error("Stripe.js loaded without Stripe factory."));
			});
			existing.addEventListener("error", () => {
				reject(/* @__PURE__ */ new Error("Failed to load Stripe.js."));
			});
			return;
		}
		const script = document.createElement("script");
		script.src = "https://js.stripe.com/v3/";
		script.async = true;
		script.dataset.elizaStripeLoader = "true";
		script.onload = () => {
			if (typeof window.Stripe === "function") resolve(window.Stripe);
			else reject(/* @__PURE__ */ new Error("Stripe.js loaded without Stripe factory."));
		};
		script.onerror = () => {
			reject(/* @__PURE__ */ new Error("Failed to load Stripe.js."));
		};
		document.head.appendChild(script);
	});
	return stripeLoader;
}
function StripeEmbeddedCheckout({ publishableKey, clientSecret, className = "" }) {
	const containerRef = useRef(null);
	const checkoutRef = useRef(null);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let cancelled = false;
		const setup = async () => {
			setLoading(true);
			setError(null);
			try {
				const stripeFactory = await loadStripeFactory();
				if (cancelled) return;
				const checkout = await stripeFactory(publishableKey).initEmbeddedCheckout({ fetchClientSecret: async () => clientSecret });
				if (cancelled) {
					checkout.destroy?.();
					return;
				}
				checkoutRef.current = checkout;
				if (containerRef.current) checkout.mount(containerRef.current);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load embedded checkout.");
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		setup();
		return () => {
			cancelled = true;
			checkoutRef.current?.unmount?.();
			checkoutRef.current?.destroy?.();
			checkoutRef.current = null;
		};
	}, [clientSecret, publishableKey]);
	if (error) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger",
		children: error
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className,
		children: [loading ? (0, import_jsx_runtime.jsx)("div", {
			className: "rounded-2xl border border-border/50 bg-bg/40 px-4 py-6 text-sm text-muted",
			children: "Loading secure checkout…"
		}) : null, (0, import_jsx_runtime.jsx)("div", {
			ref: containerRef,
			className: loading ? "hidden" : "block"
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ElizaCloudDashboard.js
function CloudDashboard() {
	const { t, elizaCloudConnected, elizaCloudCredits, elizaCloudCreditsLow, elizaCloudCreditsCritical, elizaCloudAuthRejected, elizaCloudTopUpUrl, elizaCloudUserId, elizaCloudStatusReason, cloudDashboardView, elizaCloudLoginBusy, handleCloudLogin, handleCloudDisconnect, elizaCloudDisconnecting: cloudDisconnecting, setActionNotice, setState } = useApp();
	const [refreshing, setRefreshing] = useState(false);
	const [billingLoading, setBillingLoading] = useState(false);
	const [billingError, setBillingError] = useState(null);
	const [billingSummary, setBillingSummary] = useState(null);
	const [billingSettings, setBillingSettings] = useState(null);
	const [billingAmount, setBillingAmount] = useState("25");
	const [autoTopUpForm, dispatchAutoTopUpForm] = useReducer(autoTopUpFormReducer, buildAutoTopUpFormState(null, null));
	const [billingSettingsBusy, setBillingSettingsBusy] = useState(false);
	const [checkoutBusy, setCheckoutBusy] = useState(false);
	const [checkoutSession, setCheckoutSession] = useState(null);
	const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false);
	const mountedRef = useRef(true);
	const handledDiscordCallbackRef = useRef(false);
	const handledGithubCallbackRef = useRef(false);
	const autoTopUpEnabled = autoTopUpForm.enabled;
	const autoTopUpAmount = autoTopUpForm.amount;
	const autoTopUpThreshold = autoTopUpForm.threshold;
	const view = cloudDashboardView;
	const goOverview = useCallback(() => setState("cloudDashboardView", "overview"), [setState]);
	const goBilling = useCallback(() => setState("cloudDashboardView", "billing"), [setState]);
	const fetchBillingData = useCallback(async () => {
		setBillingLoading(true);
		setBillingError(null);
		try {
			const [summaryResponse, settingsResponse] = await Promise.all([client.getCloudBillingSummary().catch((err) => ({ __error: err })), client.getCloudBillingSettings().catch((err) => ({ __error: err }))]);
			if (!mountedRef.current) return;
			if (isRecord$1(summaryResponse) && "__error" in summaryResponse) {
				const err = summaryResponse.__error;
				throw err instanceof Error ? err : new Error(t("elizaclouddashboard.BillingSummaryUnavailable", { defaultValue: "Billing summary unavailable." }));
			}
			setBillingSummary(normalizeBillingSummary(summaryResponse));
			if (isRecord$1(settingsResponse) && !("__error" in settingsResponse)) setBillingSettings(normalizeBillingSettings(settingsResponse));
			else setBillingSettings(null);
		} catch (err) {
			if (!mountedRef.current) return;
			setBillingSummary(null);
			setBillingSettings(null);
			setBillingError(err instanceof Error ? err.message : t("elizaclouddashboard.FailedToLoadBillingData", { defaultValue: "Failed to load billing data." }));
		} finally {
			if (mountedRef.current) setBillingLoading(false);
		}
	}, [t]);
	useEffect(() => {
		dispatchAutoTopUpForm({
			type: "hydrate",
			next: buildAutoTopUpFormState(billingSummary, billingSettings)
		});
	}, [billingSettings, billingSummary]);
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		await fetchBillingData();
		setTimeout(() => setRefreshing(false), 400);
	}, [fetchBillingData]);
	const handleSaveBillingSettings = useCallback(async () => {
		const limits = getBillingLimits(billingSettings);
		const amount = Number(autoTopUpAmount);
		const threshold = Number(autoTopUpThreshold);
		const minAmount = readNumber(limits.minAmount) ?? 1;
		const maxAmount = readNumber(limits.maxAmount) ?? 1e3;
		const minThreshold = readNumber(limits.minThreshold) ?? 0;
		const maxThreshold = readNumber(limits.maxThreshold) ?? 1e3;
		const hasPaymentMethod = readBoolean(getBillingAutoTopUp(billingSettings).hasPaymentMethod) ?? readBoolean(billingSummary?.hasPaymentMethod) ?? false;
		if (!Number.isFinite(amount) || amount < minAmount || amount > maxAmount) {
			setActionNotice(t("elizaclouddashboard.AutoTopUpAmountRange", {
				defaultValue: "Auto top-up amount must be between ${{min}} and ${{max}}.",
				min: minAmount,
				max: maxAmount
			}), "error", 3600);
			return;
		}
		if (!Number.isFinite(threshold) || threshold < minThreshold || threshold > maxThreshold) {
			setActionNotice(t("elizaclouddashboard.AutoTopUpThresholdRange", {
				defaultValue: "Auto top-up threshold must be between ${{min}} and ${{max}}.",
				min: minThreshold,
				max: maxThreshold
			}), "error", 3600);
			return;
		}
		if (autoTopUpEnabled && !hasPaymentMethod) {
			setActionNotice(t("elizaclouddashboard.SavePaymentMethodBeforeAutoTopUp", { defaultValue: "Add a card first" }), "info", 4200);
			return;
		}
		setBillingSettingsBusy(true);
		try {
			const response = await client.updateCloudBillingSettings({ autoTopUp: {
				enabled: autoTopUpEnabled,
				amount,
				threshold
			} });
			if (!mountedRef.current) return;
			const normalizedSettings = normalizeBillingSettings(response);
			setBillingSettings(normalizedSettings);
			dispatchAutoTopUpForm({
				type: "hydrate",
				next: buildAutoTopUpFormState(billingSummary, normalizedSettings),
				force: true
			});
			await fetchBillingData();
			setActionNotice(t("elizaclouddashboard.BillingSettingsUpdated", { defaultValue: "Billing settings updated." }), "success", 3200);
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : t("elizaclouddashboard.FailedToUpdateBillingSettings", { defaultValue: "Failed to update billing settings." }), "error", 4200);
		} finally {
			if (mountedRef.current) setBillingSettingsBusy(false);
		}
	}, [
		autoTopUpAmount,
		autoTopUpEnabled,
		autoTopUpThreshold,
		billingSettings,
		billingSummary,
		fetchBillingData,
		setActionNotice,
		t
	]);
	const handleStartCheckout = useCallback(async () => {
		const minimumTopUp = readNumber(billingSummary?.minimumTopUp) ?? 1;
		const amountUsd = Number(billingAmount);
		if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
			setActionNotice(t("elizaclouddashboard.EnterTopUpAmountMinimum", {
				defaultValue: "Enter a top-up amount of at least ${{amount}}.",
				amount: minimumTopUp
			}), "error", 3200);
			return;
		}
		setCheckoutBusy(true);
		try {
			const response = await client.createCloudBillingCheckout({
				amountUsd,
				mode: billingSummary?.embeddedCheckoutEnabled ? "embedded" : "hosted"
			});
			const clientSecret = readString(response.clientSecret);
			const publishableKey = readString(response.publishableKey);
			if (clientSecret && publishableKey) {
				setCheckoutSession(response);
				setCheckoutDialogOpen(true);
				return;
			}
			const checkoutUrl = resolveCheckoutUrl(response);
			if (checkoutUrl) {
				await openExternalUrl(checkoutUrl);
				return;
			}
			throw new Error(t("elizaclouddashboard.CheckoutSessionMissing", { defaultValue: "Checkout unavailable. Try again or use the billing portal." }));
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : t("elizaclouddashboard.FailedToStartCheckout", { defaultValue: "Failed to start checkout." }), "error", 4200);
		} finally {
			setCheckoutBusy(false);
		}
	}, [
		billingAmount,
		billingSummary,
		setActionNotice,
		t
	]);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	useEffect(() => {
		if (elizaCloudConnected) fetchBillingData();
	}, [elizaCloudConnected, fetchBillingData]);
	useEffect(() => {
		if (elizaCloudConnected) return;
		setBillingSummary(null);
		setBillingSettings(null);
		setBillingError(null);
		setCheckoutSession(null);
		setCheckoutDialogOpen(false);
		dispatchAutoTopUpForm({
			type: "hydrate",
			next: buildAutoTopUpFormState(null, null),
			force: true
		});
	}, [elizaCloudConnected]);
	useEffect(() => {
		if (handledDiscordCallbackRef.current || typeof window === "undefined") return;
		const { callback, cleanedUrl } = consumeManagedDiscordCallbackUrl(window.location.href);
		if (!callback) return;
		handledDiscordCallbackRef.current = true;
		if (cleanedUrl && cleanedUrl !== window.location.href) window.history.replaceState({}, document.title, cleanedUrl);
		if (callback.status === "connected") {
			setActionNotice(callback.guildName ? t("elizaclouddashboard.ManagedDiscordConnectedNotice", {
				defaultValue: callback.restarted ? "Managed Discord connected to {{guild}}. The agent restarted and is ready." : "Managed Discord connected to {{guild}}.",
				guild: callback.guildName
			}) : t("elizaclouddashboard.ManagedDiscordConnectedNoticeFallback", { defaultValue: callback.restarted ? "Managed Discord connected. The agent restarted and is ready." : "Managed Discord connected." }), "success", 5200);
			return;
		}
		setActionNotice(callback.message || t("elizaclouddashboard.ManagedDiscordConnectFailed", { defaultValue: "Managed Discord setup did not complete." }), "error", 5200);
	}, [setActionNotice, t]);
	useEffect(() => {
		if (handledGithubCallbackRef.current || typeof window === "undefined") return;
		const { callback, cleanedUrl } = consumeManagedGithubCallbackUrl(window.location.href);
		if (!callback) return;
		handledGithubCallbackRef.current = true;
		if (cleanedUrl && cleanedUrl !== window.location.href) window.history.replaceState({}, document.title, cleanedUrl);
		if (callback.status === "connected") {
			setActionNotice(t("elizaclouddashboard.ManagedGithubConnectedNotice", { defaultValue: "GitHub account connected to this agent." }), "success", 5200);
			return;
		}
		setActionNotice(callback.message || t("lifeopspage.githubSetupIncomplete", { defaultValue: "GitHub setup did not complete." }), "error", 5200);
	}, [setActionNotice, t]);
	const summaryCritical = elizaCloudAuthRejected || (billingSummary?.critical ?? elizaCloudCreditsCritical ?? false);
	const summaryLow = billingSummary?.low ?? elizaCloudCreditsLow ?? false;
	const creditStatusColor = summaryCritical ? "text-danger" : summaryLow ? "text-warn" : "text-ok";
	const cloudBalanceNumber = typeof elizaCloudCredits === "number" ? elizaCloudCredits : typeof billingSummary?.balance === "number" ? billingSummary.balance : null;
	const cloudCurrency = billingSummary?.currency ?? "USD";
	const fallbackBillingUrl = billingSummary?.topUpUrl ?? elizaCloudTopUpUrl ?? null;
	const minimumTopUp = readNumber(billingSummary?.minimumTopUp) ?? 1;
	const billingAutoTopUp = getBillingAutoTopUp(billingSettings);
	const billingLimits = getBillingLimits(billingSettings);
	const autoTopUpHasPaymentMethod = readBoolean(billingAutoTopUp.hasPaymentMethod) ?? readBoolean(billingSummary?.hasPaymentMethod) ?? false;
	const autoTopUpMinAmount = readNumber(billingLimits.minAmount) ?? minimumTopUp;
	const autoTopUpMaxAmount = readNumber(billingLimits.maxAmount) ?? 1e3;
	const autoTopUpMinThreshold = readNumber(billingLimits.minThreshold) ?? 0;
	const autoTopUpMaxThreshold = readNumber(billingLimits.maxThreshold) ?? 1e3;
	const creditStatusTone = elizaCloudAuthRejected ? t("notice.elizaCloudAuthRejected") : summaryCritical ? t("elizaclouddashboard.CreditsCritical") : summaryLow ? t("elizaclouddashboard.CreditsLow") : t("elizaclouddashboard.CreditsHealthy");
	const statusChipClass = summaryCritical ? "border-danger/30 bg-danger/10 text-danger" : summaryLow ? "border-warn/30 bg-warn/10 text-warn" : "border-ok/30 bg-ok/10 text-ok";
	const accountIdDisplay = resolveCloudAccountIdDisplay(elizaCloudUserId, elizaCloudStatusReason, t);
	const formattedBalance = cloudBalanceNumber !== null ? cloudBalanceNumber.toFixed(2) : null;
	const currencyPrefix = cloudCurrency === "USD" ? "$" : `${cloudCurrency} `;
	if (!elizaCloudConnected) return (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto flex max-w-sm flex-wrap items-center justify-center gap-2 px-3 py-5 text-center",
		children: [(0, import_jsx_runtime.jsxs)(Button, {
			variant: "default",
			size: "sm",
			className: "h-8 rounded-lg px-3 text-xs font-semibold",
			onClick: () => void handleCloudLogin(preOpenWindow()),
			disabled: elizaCloudLoginBusy,
			children: [elizaCloudLoginBusy ? (0, import_jsx_runtime.jsx)(RefreshCw, { className: "mr-2 h-4 w-4 animate-spin" }) : (0, import_jsx_runtime.jsx)(Zap, { className: "mr-2 h-4 w-4" }), elizaCloudLoginBusy ? t("game.connecting") : t("elizaclouddashboard.ConnectElizaCloud")]
		}), (0, import_jsx_runtime.jsx)(Button, {
			variant: "link",
			className: "h-8 px-2 text-xs text-muted",
			onClick: () => void openExternalUrl(ELIZA_CLOUD_WEB_URL),
			children: t("elizaclouddashboard.LearnMore")
		})]
	});
	const overviewContent = (0, import_jsx_runtime.jsxs)("div", {
		className: "px-3 py-2 sm:px-4",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex min-w-0 items-center gap-2",
						children: [
							(0, import_jsx_runtime.jsx)(CreditCard, {
								className: "h-4 w-4 shrink-0 text-muted",
								"aria-hidden": true
							}),
							(0, import_jsx_runtime.jsxs)("span", {
								className: `text-base font-semibold tracking-tight tabular-nums ${creditStatusColor}`,
								children: [currencyPrefix, formattedBalance ?? (0, import_jsx_runtime.jsx)("span", {
									className: "text-muted",
									children: billingLoading ? "…" : "—"
								})]
							}),
							billingLoading && (0, import_jsx_runtime.jsx)(Loader2, { className: "h-3.5 w-3.5 animate-spin text-muted" })
						]
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: `shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider ${statusChipClass}`,
						children: creditStatusTone
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "ml-auto flex flex-wrap items-center gap-1.5",
						children: [
							(0, import_jsx_runtime.jsxs)(Button, {
								variant: "default",
								size: "sm",
								className: "h-8 rounded-lg px-2.5 text-xs font-semibold",
								onClick: goBilling,
								children: [(0, import_jsx_runtime.jsx)(CreditCard, { className: "mr-1.5 h-3.5 w-3.5" }), t("elizaclouddashboard.TopUpCredits", { defaultValue: "Top up credits" })]
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "icon",
								className: "h-8 w-8 rounded-lg",
								onClick: handleRefresh,
								disabled: refreshing || billingLoading,
								"aria-label": t("common.refresh"),
								title: t("common.refresh"),
								children: (0, import_jsx_runtime.jsx)(RefreshCw, { className: `h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}` })
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								type: "button",
								variant: "outline",
								size: "sm",
								className: "h-8 rounded-lg border-danger/30 px-2.5 text-danger text-xs hover:bg-danger/10",
								onClick: () => void handleCloudDisconnect(),
								disabled: cloudDisconnecting,
								children: cloudDisconnecting ? t("providerswitcher.disconnecting") : t("common.disconnect")
							})
						]
					})
				]
			}),
			elizaCloudAuthRejected && (0, import_jsx_runtime.jsx)("div", {
				role: "alert",
				className: "mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger",
				children: t("notice.elizaCloudAuthRejected")
			}),
			billingError && (0, import_jsx_runtime.jsx)("div", {
				role: "alert",
				className: "mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
				children: billingError
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mt-2 flex flex-wrap gap-1.5 text-xs",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "inline-flex max-w-full items-center rounded-md border border-border/50 bg-bg/55 px-2 py-1 text-muted",
					title: t("common.account", { defaultValue: "Account" }),
					children: accountIdDisplay.mono ? (0, import_jsx_runtime.jsx)("code", {
						className: "truncate font-mono text-txt",
						children: accountIdDisplay.text
					}) : (0, import_jsx_runtime.jsx)("span", {
						className: "truncate text-txt",
						children: accountIdDisplay.text
					})
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "inline-flex items-center rounded-md border border-border/50 bg-bg/55 px-2 py-1 text-muted",
					title: t("elizaclouddashboard.AutoTopUp", { defaultValue: "Auto top-up" }),
					children: billingAutoTopUp.enabled ? t("elizaclouddashboard.OnAmount", {
						defaultValue: "Auto ${{amount}} below ${{threshold}}",
						amount: Number(autoTopUpForm.amount).toFixed(0),
						threshold: Number(autoTopUpForm.threshold).toFixed(0)
					}) : t("elizaclouddashboard.AutoTopUpOff", { defaultValue: "Auto top-up off" })
				})]
			})
		]
	});
	const billingContent = (0, import_jsx_runtime.jsxs)("div", {
		className: "px-5 py-6 sm:px-6",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-5 flex items-center gap-2",
				children: [
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-8 rounded-lg px-2 text-muted hover:text-txt",
						onClick: goOverview,
						"aria-label": t("common.back", { defaultValue: "Back" }),
						children: (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" })
					}),
					(0, import_jsx_runtime.jsx)("h3", {
						className: "text-sm font-semibold text-txt-strong",
						children: t("elizaclouddashboard.TopUpCredits", { defaultValue: "Top up credits" })
					}),
					(0, import_jsx_runtime.jsxs)("span", {
						className: "ml-auto text-xs text-muted tabular-nums",
						children: [currencyPrefix, formattedBalance ?? (billingLoading ? "…" : "—")]
					})
				]
			}),
			billingError && (0, import_jsx_runtime.jsx)("div", {
				role: "alert",
				className: "mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
				children: billingError
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-6",
				children: [
					(0, import_jsx_runtime.jsx)("div", {
						className: "mb-2 text-xs font-medium uppercase tracking-wider text-muted",
						children: t("elizaclouddashboard.PayWithCard")
					}),
					(0, import_jsx_runtime.jsx)("div", {
						className: "mb-2 flex flex-wrap gap-1.5",
						children: BILLING_PRESET_AMOUNTS.map((amount) => {
							return (0, import_jsx_runtime.jsxs)(Button, {
								variant: billingAmount === String(amount) ? "default" : "outline",
								size: "sm",
								className: "h-8 rounded-lg px-3 text-xs font-medium",
								onClick: () => setBillingAmount(String(amount)),
								children: ["$", amount]
							}, amount);
						})
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex gap-2",
						children: [(0, import_jsx_runtime.jsx)(Input, {
							id: "cloud-billing-amount",
							type: "number",
							min: String(minimumTopUp),
							step: "1",
							value: billingAmount,
							onChange: (e) => setBillingAmount(e.target.value),
							className: "h-9 flex-1 rounded-lg bg-bg text-sm",
							placeholder: t("elizaclouddashboard.MinAmountPlaceholder", {
								defaultValue: "Min ${{amount}}",
								amount: minimumTopUp.toFixed(2)
							})
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-9 rounded-lg px-4 font-semibold",
							disabled: checkoutBusy || billingLoading,
							onClick: () => void handleStartCheckout(),
							children: checkoutBusy ? (0, import_jsx_runtime.jsx)(Loader2, { className: "h-4 w-4 animate-spin" }) : t("elizaclouddashboard.Pay", { defaultValue: "Pay" })
						})]
					})
				]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-6 border-t border-border/40 pt-5",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "mb-3 flex items-center justify-between gap-3",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "text-xs font-medium uppercase tracking-wider text-muted",
							children: t("elizaclouddashboard.AutoTopUp")
						}), (0, import_jsx_runtime.jsx)("p", {
							className: "mt-0.5 text-xs-tight text-muted",
							children: autoTopUpHasPaymentMethod ? t("elizaclouddashboard.AutoTopUpPaymentReady", { defaultValue: "Card saved" }) : t("elizaclouddashboard.AutoTopUpNeedsPaymentMethod", { defaultValue: "Add a card first" })
						})]
					}), (0, import_jsx_runtime.jsx)(Switch, {
						checked: autoTopUpEnabled,
						onCheckedChange: (v) => dispatchAutoTopUpForm({
							type: "setEnabled",
							value: v
						}),
						"aria-label": t("elizaclouddashboard.ToggleAutoTopUp")
					})]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-2 sm:flex-row sm:items-end",
					children: [
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex-1 space-y-1",
							children: [(0, import_jsx_runtime.jsx)("label", {
								htmlFor: "cloud-auto-topup-threshold",
								className: "text-xs-tight text-muted",
								children: t("elizaclouddashboard.RefillWhenBelow", { defaultValue: "Refill when below" })
							}), (0, import_jsx_runtime.jsx)(Input, {
								id: "cloud-auto-topup-threshold",
								type: "number",
								min: String(autoTopUpMinThreshold),
								max: String(autoTopUpMaxThreshold),
								step: "1",
								value: autoTopUpThreshold,
								onChange: (e) => dispatchAutoTopUpForm({
									type: "setThreshold",
									value: e.target.value
								}),
								className: "h-9 rounded-lg bg-bg"
							})]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex-1 space-y-1",
							children: [(0, import_jsx_runtime.jsx)("label", {
								htmlFor: "cloud-auto-topup-amount",
								className: "text-xs-tight text-muted",
								children: t("elizaclouddashboard.TopUpAmount", { defaultValue: "Top-up amount" })
							}), (0, import_jsx_runtime.jsx)(Input, {
								id: "cloud-auto-topup-amount",
								type: "number",
								min: String(autoTopUpMinAmount),
								max: String(autoTopUpMaxAmount),
								step: "1",
								value: autoTopUpAmount,
								onChange: (e) => dispatchAutoTopUpForm({
									type: "setAmount",
									value: e.target.value
								}),
								className: "h-9 rounded-lg bg-bg"
							})]
						}),
						(0, import_jsx_runtime.jsxs)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-9 rounded-lg px-4 sm:self-end",
							disabled: billingSettingsBusy || billingLoading || !autoTopUpForm.dirty,
							onClick: () => void handleSaveBillingSettings(),
							children: [billingSettingsBusy && (0, import_jsx_runtime.jsx)(Loader2, { className: "mr-1 h-3 w-3 animate-spin" }), t("common.save")]
						})
					]
				})]
			}),
			fallbackBillingUrl && (0, import_jsx_runtime.jsxs)(Button, {
				variant: "ghost",
				size: "sm",
				className: "h-auto p-0 text-xs text-muted hover:text-txt",
				onClick: () => void openExternalUrl(fallbackBillingUrl),
				children: [t("elizaclouddashboard.OpenBrowserBilling"), (0, import_jsx_runtime.jsx)(ExternalLink, { className: "ml-1 h-3 w-3" })]
			})
		]
	});
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [view === "billing" ? billingContent : overviewContent, (0, import_jsx_runtime.jsx)(Dialog, {
		open: checkoutDialogOpen,
		onOpenChange: (open) => {
			setCheckoutDialogOpen(open);
			if (!open) fetchBillingData();
		},
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			className: "max-w-4xl",
			children: [(0, import_jsx_runtime.jsx)(DialogHeader, { children: (0, import_jsx_runtime.jsx)(DialogTitle, { children: t("elizaclouddashboard.PayWithCard") }) }), checkoutSession?.clientSecret && checkoutSession.publishableKey ? (0, import_jsx_runtime.jsx)(StripeEmbeddedCheckout, {
				publishableKey: checkoutSession.publishableKey,
				clientSecret: checkoutSession.clientSecret
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-2xl border border-border/40 bg-bg/25 px-4 py-5 text-sm text-muted",
				children: t("elizaclouddashboard.CheckoutProviderNote")
			})]
		})
	})] });
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/release-center/shared.js
function summarizeError(error) {
	return error instanceof Error ? error.message : String(error);
}
function normalizeReleaseNotesUrl(url) {
	const candidate = url?.trim() || "https://elizaos.ai/releases/";
	try {
		return new URL(candidate).toString();
	} catch {
		return "https://elizaos.ai/releases/";
	}
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ReleaseCenterView.js
function ReleaseCenterView() {
	const { appUrl } = useBranding();
	const defaultReleaseNotesUrl = `${appUrl}/releases/`;
	const desktopRuntime = isElectrobunRuntime();
	const { loadUpdateStatus, t, updateLoading, updateStatus } = useApp();
	const [busyAction, setBusyAction] = useState(null);
	const [actionError, setActionError] = useState(null);
	const [actionMessage, setActionMessage] = useState(null);
	const [nativeUpdater, setNativeUpdater] = useState(null);
	const [releaseNotesUrl, setReleaseNotesUrl] = useState(defaultReleaseNotesUrl);
	const [releaseNotesUrlDirty, setReleaseNotesUrlDirty] = useState(false);
	const refreshNativeState = useCallback(async () => {
		if (!desktopRuntime) return;
		const snapshot = await invokeDesktopBridgeRequest({
			rpcMethod: "desktopGetUpdaterState",
			ipcChannel: "desktop:getUpdaterState"
		}).catch(() => null);
		setNativeUpdater(snapshot);
		setReleaseNotesUrl((current) => releaseNotesUrlDirty ? current : normalizeReleaseNotesUrl(snapshot?.baseUrl ?? current));
	}, [desktopRuntime, releaseNotesUrlDirty]);
	useEffect(() => {
		loadUpdateStatus();
	}, [loadUpdateStatus]);
	useEffect(() => {
		if (!desktopRuntime) return;
		refreshNativeState();
	}, [desktopRuntime, refreshNativeState]);
	useEffect(() => {
		if (!desktopRuntime) return;
		const unsubscribers = [subscribeDesktopBridgeEvent({
			rpcMessage: "desktopUpdateAvailable",
			ipcChannel: "desktop:updateAvailable",
			listener: () => void refreshNativeState()
		}), subscribeDesktopBridgeEvent({
			rpcMessage: "desktopUpdateReady",
			ipcChannel: "desktop:updateReady",
			listener: () => void refreshNativeState()
		})];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [desktopRuntime, refreshNativeState]);
	const runAction = useCallback(async (id, action, successMessage) => {
		setBusyAction(id);
		setActionError(null);
		setActionMessage(null);
		try {
			const result = await action();
			if (successMessage) setActionMessage(successMessage);
			return result;
		} catch (error) {
			setActionError(summarizeError(error));
			return null;
		} finally {
			setBusyAction(null);
		}
	}, []);
	const detachReleaseCenter = async () => {
		if (!desktopRuntime) return;
		await openDesktopSurfaceWindow("release");
	};
	const refreshReleaseState = async () => {
		if (desktopRuntime) {
			await Promise.all([loadUpdateStatus(true), refreshNativeState()]);
			return;
		}
		await loadUpdateStatus(true);
	};
	const checkForDesktopUpdate = async () => {
		if (!desktopRuntime) return;
		const snapshot = await invokeDesktopBridgeRequest({
			rpcMethod: "desktopCheckForUpdates",
			ipcChannel: "desktop:checkForUpdates"
		});
		setNativeUpdater(snapshot);
		if (!releaseNotesUrlDirty && snapshot?.baseUrl) setReleaseNotesUrl(normalizeReleaseNotesUrl(snapshot.baseUrl));
	};
	const applyDesktopUpdate = async () => {
		if (!desktopRuntime) return;
		await invokeDesktopBridgeRequest({
			rpcMethod: "desktopApplyUpdate",
			ipcChannel: "desktop:applyUpdate"
		});
	};
	const openReleaseNotesWindow = async () => {
		if (!desktopRuntime) {
			await openExternalUrl(releaseNotesUrl);
			return;
		}
		await invokeDesktopBridgeRequest({
			rpcMethod: "desktopOpenReleaseNotesWindow",
			ipcChannel: "desktop:openReleaseNotesWindow",
			params: {
				url: releaseNotesUrl,
				title: t("releasecenterview.ReleaseNotes", { defaultValue: "Release Notes" })
			}
		});
	};
	const appStatus = updateStatus;
	const appVersion = appStatus?.currentVersion ?? "—";
	const desktopVersion = nativeUpdater?.currentVersion ?? "—";
	const channel = nativeUpdater?.channel ?? "—";
	const latestVersion = appStatus?.latestVersion ?? t("releasecenterview.Current", { defaultValue: "Current" });
	const lastCheckAt = appStatus?.lastCheckAt;
	const lastChecked = lastCheckAt ? new Date(lastCheckAt).toLocaleString() : t("releasecenter.NotYet", { defaultValue: "Not yet" });
	const updaterStatus = nativeUpdater?.updateReady ? t("releasecenterview.UpdateReady", { defaultValue: "Update ready" }) : nativeUpdater?.updateAvailable ? t("releasecenterview.UpdateAvailable", { defaultValue: "Update available" }) : t("common.idle", { defaultValue: "Idle" });
	const updaterNeedsAttention = Boolean(nativeUpdater?.updateReady || nativeUpdater?.updateAvailable);
	const autoUpdateDisabled = nativeUpdater != null && !nativeUpdater.canAutoUpdate;
	const versionRows = [
		{
			label: t("releasecenterview.App", { defaultValue: "App" }),
			value: appVersion
		},
		...desktopRuntime ? [{
			label: t("common.desktop", { defaultValue: "Desktop" }),
			value: desktopVersion
		}, {
			label: t("common.channel", { defaultValue: "Channel" }),
			value: channel
		}] : [],
		{
			label: t("releasecenterview.Latest", { defaultValue: "Latest" }),
			value: latestVersion
		},
		{
			label: t("releasecenter.LastChecked", { defaultValue: "Last checked" }),
			value: lastChecked
		},
		{
			label: t("common.status", { defaultValue: "Status" }),
			value: (0, import_jsx_runtime.jsxs)("span", {
				className: "inline-flex items-center gap-1.5",
				children: [updaterNeedsAttention ? (0, import_jsx_runtime.jsx)(AlertTriangle, {
					className: "h-3.5 w-3.5 text-warn",
					"aria-hidden": true
				}) : (0, import_jsx_runtime.jsx)(CheckCircle2, {
					className: "h-3.5 w-3.5 text-ok",
					"aria-hidden": true
				}), updaterStatus]
			})
		}
	];
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-5",
		children: [
			actionError && (0, import_jsx_runtime.jsx)("div", {
				role: "alert",
				className: "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive",
				children: actionError
			}),
			actionMessage && (0, import_jsx_runtime.jsx)("div", {
				role: "status",
				className: "rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok",
				children: actionMessage
			}),
			autoUpdateDisabled && nativeUpdater?.autoUpdateDisabledReason && (0, import_jsx_runtime.jsx)("div", {
				role: "status",
				className: "rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning",
				children: nativeUpdater.autoUpdateDisabledReason
			}),
			(0, import_jsx_runtime.jsx)("dl", {
				className: "grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2",
				children: versionRows.map((row) => (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5",
					children: [(0, import_jsx_runtime.jsx)("dt", {
						className: "text-muted",
						children: row.label
					}), (0, import_jsx_runtime.jsx)("dd", {
						className: "break-all text-right font-medium text-txt",
						children: row.value
					})]
				}, row.label))
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap gap-2",
				children: [
					desktopRuntime ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						className: "h-9 rounded-lg px-3 text-xs font-medium",
						disabled: busyAction === "check-updates" || updateLoading || autoUpdateDisabled,
						onClick: () => void runAction("check-updates", checkForDesktopUpdate, t("releasecenterview.CheckStarted", { defaultValue: "Desktop update check started." })),
						children: t("releasecenter.CheckDownloadUpdate", { defaultValue: "Check / Download Update" })
					}) : null,
					desktopRuntime && nativeUpdater?.updateReady && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						className: "h-9 rounded-lg px-3 text-xs font-medium",
						disabled: busyAction === "apply-update" || autoUpdateDisabled,
						onClick: () => void runAction("apply-update", applyDesktopUpdate, t("releasecenterview.ApplyStarted", { defaultValue: "Applying downloaded update." })),
						children: t("releasecenter.ApplyDownloadedUpdate", { defaultValue: "Apply Downloaded Update" })
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						size: "icon",
						variant: "outline",
						className: "h-9 w-9 rounded-lg",
						disabled: busyAction === "refresh" || updateLoading,
						"aria-label": t("common.refresh"),
						title: t("common.refresh"),
						onClick: () => void runAction("refresh", refreshReleaseState, t("releasecenterview.ReleaseStatusRefreshed", { defaultValue: "Release status refreshed." })),
						children: (0, import_jsx_runtime.jsx)(RefreshCw, {
							className: `h-4 w-4 ${busyAction === "refresh" || updateLoading ? "animate-spin" : ""}`,
							"aria-hidden": true
						})
					}),
					desktopRuntime ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "outline",
						className: "h-9 rounded-lg px-3 text-xs font-medium",
						disabled: busyAction === "detach-release",
						onClick: () => void runAction("detach-release", detachReleaseCenter, t("releasecenterview.DetachedOpened", { defaultValue: "Detached release center opened." })),
						children: t("releasecenter.OpenDetachedReleaseCenter", { defaultValue: "Open Detached Release Center" })
					}) : null
				]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "border-t border-border/40 pt-4",
				children: [(0, import_jsx_runtime.jsx)("label", {
					htmlFor: "release-notes-url",
					className: "mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted",
					children: t("releasecenterview.ReleaseNotes", { defaultValue: "Release Notes" })
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-2 sm:flex-row",
					children: [(0, import_jsx_runtime.jsx)(Input, {
						id: "release-notes-url",
						type: "text",
						className: "h-9 flex-1 rounded-lg bg-bg text-xs",
						value: releaseNotesUrl,
						onChange: (e) => {
							setReleaseNotesUrlDirty(true);
							setReleaseNotesUrl(e.target.value);
						}
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap gap-2 sm:justify-end",
						children: [(0, import_jsx_runtime.jsxs)(Button, {
							size: "sm",
							variant: "outline",
							className: "h-9 rounded-lg px-3 text-xs font-medium",
							disabled: busyAction === "open-release-notes",
							onClick: () => void runAction("open-release-notes", openReleaseNotesWindow, t("releasecenterview.ReleaseNotesOpened", { defaultValue: "Release notes opened." })),
							children: [(0, import_jsx_runtime.jsx)(ExternalLink, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							}), t("common.open", { defaultValue: "Open" })]
						}), (0, import_jsx_runtime.jsx)(Button, {
							size: "icon",
							variant: "ghost",
							className: "h-9 w-9 rounded-lg text-muted-strong",
							"aria-label": t("releasecenter.ResetUrl", { defaultValue: "Reset URL" }),
							title: t("releasecenter.ResetUrl", { defaultValue: "Reset URL" }),
							onClick: () => void runAction("reset-release-url", async () => {
								setReleaseNotesUrlDirty(false);
								setReleaseNotesUrl(normalizeReleaseNotesUrl(nativeUpdater?.baseUrl ?? defaultReleaseNotesUrl));
							}, t("releasecenterview.ReleaseNotesReset", { defaultValue: "Release notes URL reset." })),
							children: (0, import_jsx_runtime.jsx)(RotateCcw, {
								className: "h-4 w-4",
								"aria-hidden": true
							})
						})]
					})]
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/content-packs/apply-pack.js
/**
* Content pack application.
*
* Takes a ResolvedContentPack and applies its assets to the app state.
* This is called from the splash page after the user selects a pack.
*/
/**
* Apply a content pack to the app state.
* Call this on the splash page after the user selects a pack.
*/
function applyContentPack(pack, deps) {
	if (pack.avatarIndex != null && pack.avatarIndex > 0) {
		deps.setSelectedVrmIndex(pack.avatarIndex);
		deps.setCustomVrmUrl("");
		deps.setCustomVrmPreviewUrl("");
	} else if (pack.vrmUrl) {
		deps.setCustomVrmUrl(pack.vrmUrl);
		deps.setCustomVrmPreviewUrl(pack.vrmPreviewUrl ?? "");
		deps.setSelectedVrmIndex(0);
	}
	if (pack.backgroundUrl) deps.setCustomBackgroundUrl(pack.backgroundUrl);
	deps.setCustomWorldUrl(pack.worldUrl ?? "");
	if (pack.personality?.name) deps.setOnboardingName(pack.personality.name);
	if (pack.personality?.catchphrase) deps.setCustomCatchphrase(pack.personality.catchphrase);
	if (pack.personality?.voicePresetId) deps.setCustomVoicePresetId(pack.personality.voicePresetId);
	if (pack.avatarIndex != null && pack.avatarIndex > 0 && pack.manifest.id) deps.setOnboardingStyle(pack.manifest.id);
}
const COLOR_SCHEME_CSS_MAP = {
	accent: "--pack-accent",
	bg: "--pack-bg",
	card: "--pack-card",
	border: "--pack-border",
	text: "--pack-text",
	textMuted: "--pack-text-muted"
};
/**
* Apply a content pack's color scheme as CSS custom properties on the
* document root. Returns a cleanup function that removes them.
*
* If the pack includes a full ThemeDefinition (via `theme` field),
* it takes precedence over the narrow colorScheme.
*/
function applyColorScheme(scheme, pack) {
	if (pack?.manifest.assets.theme) {
		const mode = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
		return applyThemeToDocument(pack.manifest.assets.theme, mode);
	}
	if (!scheme || typeof document === "undefined") return () => {};
	const root = document.documentElement;
	const applied = [];
	for (const [key, cssVar] of Object.entries(COLOR_SCHEME_CSS_MAP)) {
		const value = scheme[key];
		if (value) {
			root.style.setProperty(cssVar, value);
			applied.push(cssVar);
		}
	}
	if (scheme.customProperties) for (const [key, value] of Object.entries(scheme.customProperties)) {
		if (/url\s*\(/i.test(value)) continue;
		const cssVar = key.startsWith("--") ? key : `--${key}`;
		root.style.setProperty(cssVar, value);
		applied.push(cssVar);
	}
	return () => {
		for (const cssVar of applied) root.style.removeProperty(cssVar);
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/content-packs/load-pack.js
/**
* Content pack loader.
*
* Loads a content pack from a directory URL (e.g. /packs/cyberpunk-neon/)
* or from a bundled pack definition. Validates the manifest and resolves
* asset paths to absolute URLs.
*/
var ContentPackLoadError = class extends Error {
	source;
	cause;
	constructor(message, source, cause) {
		super(message);
		this.source = source;
		this.cause = cause;
		this.name = "ContentPackLoadError";
	}
};
const filePackObjectUrls = /* @__PURE__ */ new WeakMap();
/**
* Load a content pack from a base URL (directory containing pack.json).
* The base URL should end with a trailing slash.
*/
async function loadContentPackFromUrl(baseUrl) {
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const source = {
		kind: "url",
		url: normalizedBase
	};
	const manifestUrl = `${normalizedBase}${CONTENT_PACK_MANIFEST_FILENAME}`;
	let raw;
	try {
		const res = await fetch(manifestUrl);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		raw = await res.json();
	} catch (err) {
		throw new ContentPackLoadError(`Failed to fetch pack manifest from ${manifestUrl}`, source, err);
	}
	const errors = validateContentPackManifest(raw);
	if (errors.length > 0) throw new ContentPackLoadError(`Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`, source);
	return resolvePackAssets(raw, normalizedBase, source);
}
/**
* Load a content pack from an array of local browser File objects (e.g. from an <input webkitdirectory />).
*/
async function loadContentPackFromFiles(files) {
	const packFile = files.find((file) => file.webkitRelativePath.endsWith(CONTENT_PACK_MANIFEST_FILENAME) || file.name === CONTENT_PACK_MANIFEST_FILENAME);
	if (!packFile) throw new ContentPackLoadError("Could not find pack.json in the selected folder.", {
		kind: "file",
		path: "local-folder"
	});
	let raw;
	try {
		raw = JSON.parse(await packFile.text());
	} catch (err) {
		throw new ContentPackLoadError("Failed to parse pack.json", {
			kind: "file",
			path: "local-folder"
		}, err);
	}
	const errors = validateContentPackManifest(raw);
	if (errors.length > 0) throw new ContentPackLoadError(`Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`, {
		kind: "file",
		path: "local-folder"
	});
	const manifest = raw;
	const { assets } = manifest;
	const objectUrls = [];
	const packRootPath = packFile.webkitRelativePath.replace(/\/?pack\.json$/, "");
	const packRootSegments = packRootPath ? packRootPath.split("/") : [];
	const resolveBlobUrl = (path) => {
		if (!path) return void 0;
		const normalizedPath = path.replace(/^\.\/|^\//, "");
		const targetSegments = [...packRootSegments, ...normalizedPath.split("/")];
		const fileMatch = files.find((file) => {
			const relativeSegments = file.webkitRelativePath ? file.webkitRelativePath.split("/") : [file.name];
			if (relativeSegments.length !== targetSegments.length) return false;
			return targetSegments.every((segment, index) => segment === relativeSegments[index]);
		});
		if (!fileMatch) return void 0;
		const objectUrl = URL.createObjectURL(fileMatch);
		objectUrls.push(objectUrl);
		return objectUrl;
	};
	const folderPath = packFile.webkitRelativePath.replace(CONTENT_PACK_MANIFEST_FILENAME, "").replace(/\/$/, "") || "local-folder";
	const pack = {
		manifest,
		vrmUrl: resolveBlobUrl(assets.vrm?.file),
		vrmPreviewUrl: resolveBlobUrl(assets.vrm?.preview),
		backgroundUrl: resolveBlobUrl(assets.background),
		worldUrl: resolveBlobUrl(assets.world),
		colorScheme: assets.colorScheme,
		personality: assets.personality,
		source: {
			kind: "file",
			path: folderPath
		}
	};
	if (objectUrls.length > 0) filePackObjectUrls.set(pack, objectUrls);
	return pack;
}
function releaseLoadedContentPack(pack) {
	const objectUrls = filePackObjectUrls.get(pack);
	if (!objectUrls) return;
	for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
	filePackObjectUrls.delete(pack);
}
function resolvePackAssets(manifest, baseUrl, source) {
	const { assets } = manifest;
	const resolve = (path) => path ? `${baseUrl}${path}` : void 0;
	return {
		manifest,
		vrmUrl: resolve(assets.vrm?.file),
		vrmPreviewUrl: resolve(assets.vrm?.preview),
		backgroundUrl: resolve(assets.background),
		worldUrl: resolve(assets.world),
		colorScheme: assets.colorScheme,
		streamOverlayPath: resolve(assets.streamOverlay),
		personality: assets.personality,
		source
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/AppearanceSettingsSection.js
function supportsDirectoryUpload() {
	if (typeof document === "undefined") return false;
	return "webkitdirectory" in document.createElement("input");
}
function isSafeContentPackUrl(value) {
	try {
		const u = new URL(value);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}
function AppearanceSettingsSection() {
	const { setState, activePackId, selectedVrmIndex, customVrmUrl, customVrmPreviewUrl, customBackgroundUrl, customWorldUrl, onboardingName, onboardingStyle, themeId, setThemeId, setUiLanguage, uiTheme, uiLanguage, setUiTheme, t } = useApp();
	const [loadedPacks, setLoadedPacks] = useState([]);
	const [packLoadError, setPackLoadError] = useState(null);
	const [urlInput, setUrlInput] = useState("");
	const colorSchemeCleanupRef = useRef(null);
	const loadedPacksRef = useRef([]);
	const baselineRef = useRef(null);
	const fileInputRef = useRef(null);
	const rehydratedRef = useRef(false);
	const canPickDirectory = useMemo(() => supportsDirectoryUpload(), []);
	useEffect(() => {
		loadedPacksRef.current = loadedPacks;
	}, [loadedPacks]);
	useEffect(() => {
		return () => {
			for (const pack of loadedPacksRef.current) releaseLoadedContentPack(pack);
		};
	}, []);
	useEffect(() => {
		if (!canPickDirectory || !fileInputRef.current) return;
		fileInputRef.current.setAttribute("webkitdirectory", "");
		fileInputRef.current.setAttribute("directory", "");
	}, [canPickDirectory]);
	useEffect(() => {
		if (rehydratedRef.current) return;
		rehydratedRef.current = true;
		if (!activePackId) return;
		const persistedUrl = loadPersistedActivePackUrl();
		if (!persistedUrl || !isSafeContentPackUrl(persistedUrl)) {
			if (persistedUrl) savePersistedActivePackUrl(null);
			return;
		}
		let cancelled = false;
		loadContentPackFromUrl(persistedUrl).then((pack) => {
			if (cancelled) return;
			setLoadedPacks((prev) => {
				if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
				return [...prev, pack];
			});
		}).catch((err) => {
			if (cancelled) return;
			console.error("[eliza][content-packs] Failed to restore persisted pack:", err);
			savePersistedActivePackUrl(null);
			setState("activePackId", null);
		});
		return () => {
			cancelled = true;
		};
	}, [activePackId, setState]);
	const activatePack = useCallback((pack) => {
		if (baselineRef.current == null) baselineRef.current = {
			selectedVrmIndex,
			customVrmUrl,
			customVrmPreviewUrl,
			customBackgroundUrl,
			customWorldUrl,
			onboardingName,
			onboardingStyle
		};
		setState("activePackId", pack.manifest.id);
		savePersistedActivePackUrl(pack.source.kind === "url" ? pack.source.url : null);
		applyContentPack(pack, {
			setCustomVrmUrl: (url) => setState("customVrmUrl", url),
			setCustomVrmPreviewUrl: (url) => setState("customVrmPreviewUrl", url),
			setCustomBackgroundUrl: (url) => setState("customBackgroundUrl", url),
			setCustomWorldUrl: (url) => setState("customWorldUrl", url),
			setSelectedVrmIndex: (idx) => setState("selectedVrmIndex", idx),
			setOnboardingName: (name) => setState("onboardingName", name),
			setOnboardingStyle: (style) => setState("onboardingStyle", style),
			setCustomCatchphrase: (phrase) => setState("customCatchphrase", phrase),
			setCustomVoicePresetId: (id) => setState("customVoicePresetId", id)
		});
		colorSchemeCleanupRef.current?.();
		colorSchemeCleanupRef.current = applyColorScheme(pack.colorScheme);
		setPackLoadError(null);
	}, [
		customBackgroundUrl,
		customVrmUrl,
		customVrmPreviewUrl,
		customWorldUrl,
		onboardingName,
		onboardingStyle,
		selectedVrmIndex,
		setState
	]);
	const deactivatePack = useCallback(() => {
		const activePack = activePackId ? loadedPacksRef.current.find((p) => p.manifest.id === activePackId) : null;
		if (activePack?.source.kind === "file") {
			releaseLoadedContentPack(activePack);
			setLoadedPacks((prev) => prev.filter((p) => p.manifest.id !== activePack.manifest.id));
		}
		setState("activePackId", null);
		savePersistedActivePackUrl(null);
		colorSchemeCleanupRef.current?.();
		colorSchemeCleanupRef.current = null;
		const baseline = baselineRef.current;
		if (baseline) {
			setState("selectedVrmIndex", baseline.selectedVrmIndex);
			setState("customVrmUrl", baseline.customVrmUrl);
			setState("customVrmPreviewUrl", baseline.customVrmPreviewUrl);
			setState("customBackgroundUrl", baseline.customBackgroundUrl);
			setState("customWorldUrl", baseline.customWorldUrl);
			setState("onboardingName", baseline.onboardingName);
			setState("onboardingStyle", baseline.onboardingStyle);
			baselineRef.current = null;
		}
		setPackLoadError(null);
	}, [activePackId, setState]);
	const handleTogglePack = useCallback((pack) => {
		if (activePackId === pack.manifest.id) deactivatePack();
		else activatePack(pack);
	}, [
		activePackId,
		activatePack,
		deactivatePack
	]);
	const handleLoadFromUrl = useCallback(async () => {
		const url = urlInput.trim();
		if (!url) return;
		if (!isSafeContentPackUrl(url)) {
			setPackLoadError("Pack URL must be an http(s) URL");
			return;
		}
		try {
			const pack = await loadContentPackFromUrl(url);
			setLoadedPacks((prev) => {
				if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
				return [...prev, pack];
			});
			activatePack(pack);
			setUrlInput("");
		} catch (err) {
			setPackLoadError(`Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`);
		}
	}, [urlInput, activatePack]);
	const handleFolderSelected = useCallback(async (e) => {
		const files = Array.from(e.target.files ?? []);
		if (files.length === 0) return;
		try {
			const pack = await loadContentPackFromFiles(files);
			setLoadedPacks((prev) => {
				if (prev.some((p) => p.manifest.id === pack.manifest.id)) {
					releaseLoadedContentPack(pack);
					return prev;
				}
				return [...prev, pack];
			});
			activatePack(pack);
		} catch (err) {
			setPackLoadError(`Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`);
		}
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, [activatePack]);
	const isDark = uiTheme === "dark";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-6",
		children: [
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-xs font-medium uppercase tracking-wider text-muted",
					children: t("settings.language", { defaultValue: "Language" })
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4",
					children: LANGUAGES.map((language) => {
						const isActive = uiLanguage === language.id;
						return (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setUiLanguage(language.id),
							className: selectableTileClass(isActive),
							children: [(0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center gap-2",
								children: [(0, import_jsx_runtime.jsx)("span", {
									className: "text-base leading-none",
									children: language.flag
								}), (0, import_jsx_runtime.jsx)("span", {
									className: "text-xs font-medium text-txt",
									children: language.label
								})]
							}), isActive ? (0, import_jsx_runtime.jsx)(Check, { className: "absolute right-1.5 top-1.5 h-3 w-3 text-accent" }) : null]
						}, language.id);
					})
				})]
			}),
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-xs font-medium uppercase tracking-wider text-muted",
					children: t("settings.appearance.mode", { defaultValue: "Mode" })
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex gap-2",
					children: [(0, import_jsx_runtime.jsx)(ModeButton, {
						active: !isDark,
						icon: (0, import_jsx_runtime.jsx)(Sun, { className: "h-4 w-4" }),
						label: t("settings.appearance.light", { defaultValue: "Light" }),
						onClick: () => setUiTheme("light")
					}), (0, import_jsx_runtime.jsx)(ModeButton, {
						active: isDark,
						icon: (0, import_jsx_runtime.jsx)(Moon, { className: "h-4 w-4" }),
						label: t("settings.appearance.dark", { defaultValue: "Dark" }),
						onClick: () => setUiTheme("dark")
					})]
				})]
			}),
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-xs font-medium uppercase tracking-wider text-muted",
					children: t("settings.appearance.theme", { defaultValue: "Theme" })
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5",
					children: BUILTIN_THEMES.map((theme) => {
						const isActive = themeId === theme.id;
						const colors = isDark ? theme.dark : theme.light;
						const swatches = [
							["bg", colors.bg ?? "transparent"],
							["card", colors.card ?? "transparent"],
							["accent", colors.accent ?? "transparent"],
							["text", colors.text ?? "transparent"]
						];
						return (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setThemeId(theme.id),
							className: selectableTileClass(isActive),
							children: [
								(0, import_jsx_runtime.jsx)("div", {
									className: "flex items-center gap-1",
									children: swatches.map(([slot, bg]) => (0, import_jsx_runtime.jsx)("span", {
										className: "h-4 w-4 rounded-full border border-border/40",
										style: { background: bg }
									}, slot))
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "text-xs font-medium text-txt",
									children: theme.name
								}),
								isActive && (0, import_jsx_runtime.jsx)(Check, { className: "absolute right-1.5 top-1.5 h-3 w-3 text-accent" })
							]
						}, theme.id);
					})
				})]
			}),
			loadedPacks.length > 0 && (0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-xs font-medium uppercase tracking-wider text-muted",
					children: t("settings.appearance.loadedPacks", { defaultValue: "Loaded content packs" })
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "grid grid-cols-1 gap-2 sm:grid-cols-2",
					children: loadedPacks.map((pack) => {
						const isActive = activePackId === pack.manifest.id;
						return (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => handleTogglePack(pack),
							className: `flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${isActive ? "border-accent bg-accent/8" : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"}`,
							children: [
								pack.vrmPreviewUrl && (0, import_jsx_runtime.jsx)("img", {
									src: pack.vrmPreviewUrl,
									alt: "",
									className: "h-9 w-9 shrink-0 rounded object-cover"
								}),
								(0, import_jsx_runtime.jsxs)("div", {
									className: "min-w-0 flex-1",
									children: [(0, import_jsx_runtime.jsx)("p", {
										className: "truncate text-sm font-medium text-txt",
										children: pack.manifest.name
									}), pack.manifest.description && (0, import_jsx_runtime.jsx)("p", {
										className: "truncate text-xs-tight text-muted",
										children: pack.manifest.description
									})]
								}),
								isActive && (0, import_jsx_runtime.jsx)("span", {
									className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent",
									title: t("settings.appearance.active", { defaultValue: "Active" }),
									role: "img",
									"aria-label": t("settings.appearance.active", { defaultValue: "Active" }),
									children: (0, import_jsx_runtime.jsx)(Check, {
										className: "h-3.5 w-3.5",
										"aria-hidden": true
									})
								})
							]
						}, pack.manifest.id);
					})
				})]
			}),
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [
					(0, import_jsx_runtime.jsx)("h3", {
						className: "text-xs font-medium uppercase tracking-wider text-muted",
						children: t("startupshell.LoadPack", { defaultValue: "Load content pack" })
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [
							(0, import_jsx_runtime.jsx)(Input, {
								placeholder: t("settings.appearance.packUrlPlaceholder", { defaultValue: "https://example.com/packs/my-pack/" }),
								value: urlInput,
								onChange: (e) => setUrlInput(e.target.value),
								className: "h-9 flex-1 rounded-lg bg-bg text-sm",
								onKeyDown: (e) => {
									if (e.key === "Enter") handleLoadFromUrl();
								}
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								className: "h-9 rounded-lg",
								onClick: handleLoadFromUrl,
								disabled: !urlInput.trim(),
								children: t("settings.appearance.load", { defaultValue: "Load" })
							}),
							canPickDirectory && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsxs)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-9 rounded-lg text-xs text-muted hover:text-txt",
								onClick: () => fileInputRef.current?.click(),
								title: t("settings.appearance.loadFromFolder", { defaultValue: "From folder" }),
								children: [(0, import_jsx_runtime.jsx)(FolderOpen, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}), t("settings.appearance.loadFromFolder", { defaultValue: "From folder" })]
							}), (0, import_jsx_runtime.jsx)("input", {
								type: "file",
								ref: fileInputRef,
								multiple: true,
								className: "hidden",
								onChange: handleFolderSelected
							})] })
						]
					}),
					packLoadError && (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight text-destructive",
						children: packLoadError
					}),
					activePackId && (0, import_jsx_runtime.jsx)(Button, {
						variant: "link",
						size: "sm",
						className: "h-auto p-0 text-xs-tight text-muted hover:text-txt",
						onClick: deactivatePack,
						children: t("settings.appearance.deactivate", { defaultValue: "Deactivate current pack" })
					})
				]
			})
		]
	});
}
function selectableTileClass(active) {
	return `relative flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-lg border p-3 transition-colors ${active ? "border-accent bg-accent/8" : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"}`;
}
function ModeButton({ active, icon, label, onClick }) {
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		onClick,
		"aria-label": label,
		title: label,
		className: `flex h-10 w-10 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${active ? "border-accent bg-accent/8 text-txt" : "border-border/50 text-muted hover:border-accent/40 hover:bg-bg-hover hover:text-txt"}`,
		children: icon
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/AppsManagementSection.js
/**
* Apps management settings panel — installed app inventory plus the
* "Create new app" and "Load from directory" entry points that the
* unified APP action exposes over HTTP.
*
* Endpoints owned by Agent C:
*   POST /api/apps/create               — { intent, editTarget? }
*   POST /api/apps/relaunch             — { name, verify? }
*   POST /api/apps/load-from-directory  — { directory }
*/
const HEAD_CELL_CLASS = "px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted";
const BODY_CELL_CLASS = "px-2 py-2 align-middle";
function AppsManagementSection() {
	const { setActionNotice, t } = useApp();
	const [installed, setInstalled] = useState([]);
	const [runs, setRuns] = useState([]);
	const [listStatus, setListStatus] = useState({ state: "loading" });
	const [busyApp, setBusyApp] = useState(null);
	const [showCreate, setShowCreate] = useState(false);
	const [createIntent, setCreateIntent] = useState("");
	const [createEditTarget, setCreateEditTarget] = useState("");
	const [createStatus, setCreateStatus] = useState({ state: "idle" });
	const [showLoad, setShowLoad] = useState(false);
	const [loadDirectory, setLoadDirectory] = useState("");
	const [loadStatus, setLoadStatus] = useState({ state: "idle" });
	const [verifyOnRelaunch, setVerifyOnRelaunch] = useState(true);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const refresh = useCallback(async () => {
		setListStatus({ state: "loading" });
		try {
			const [apps, appRuns] = await Promise.all([client.listInstalledApps(), client.listAppRuns()]);
			if (!mountedRef.current) return;
			setInstalled(apps);
			setRuns(appRuns);
			setListStatus({ state: "idle" });
		} catch (err) {
			if (!mountedRef.current) return;
			setListStatus({
				state: "error",
				message: err instanceof Error ? err.message : "Failed to load apps."
			});
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	const runsByName = useMemo(() => {
		const map = /* @__PURE__ */ new Map();
		for (const run of runs) {
			const list = map.get(run.appName) ?? [];
			list.push(run);
			map.set(run.appName, list);
		}
		return map;
	}, [runs]);
	const handleLaunch = useCallback(async (app) => {
		setBusyApp(app.name);
		try {
			await client.launchApp(app.name);
			setActionNotice(`${app.displayName} launched.`, "success", 3e3);
			await refresh();
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : `Couldn't launch ${app.displayName}.`, "error", 5e3);
		} finally {
			if (mountedRef.current) setBusyApp(null);
		}
	}, [refresh, setActionNotice]);
	const handleRelaunch = useCallback(async (app) => {
		setBusyApp(app.name);
		try {
			const response = await client.fetch("/api/apps/relaunch", {
				method: "POST",
				body: JSON.stringify({
					name: app.name,
					verify: verifyOnRelaunch
				})
			});
			setActionNotice(response.message ?? `${app.displayName} relaunched.`, response.ok === false ? "error" : "success", 4e3);
			await refresh();
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : `Couldn't relaunch ${app.displayName}.`, "error", 5e3);
		} finally {
			if (mountedRef.current) setBusyApp(null);
		}
	}, [
		refresh,
		setActionNotice,
		verifyOnRelaunch
	]);
	const handleEdit = useCallback(async (app) => {
		setBusyApp(app.name);
		try {
			const response = await client.fetch("/api/apps/create", {
				method: "POST",
				body: JSON.stringify({
					intent: "edit",
					editTarget: app.name
				})
			});
			setActionNotice(response.message ?? `Editing ${app.displayName}…`, response.ok === false ? "error" : "info", 4e3);
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : `Couldn't start an edit for ${app.displayName}.`, "error", 5e3);
		} finally {
			if (mountedRef.current) setBusyApp(null);
		}
	}, [setActionNotice]);
	const handleStop = useCallback(async (app) => {
		setBusyApp(app.name);
		try {
			const result = await client.stopApp(app.name);
			setActionNotice(result.message ?? `${app.displayName} stopped.`, result.success ? "success" : "error", 3500);
			await refresh();
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : `Couldn't stop ${app.displayName}.`, "error", 5e3);
		} finally {
			if (mountedRef.current) setBusyApp(null);
		}
	}, [refresh, setActionNotice]);
	const handleCreateSubmit = useCallback(async (event) => {
		event.preventDefault();
		const intent = createIntent.trim();
		if (!intent) return;
		setCreateStatus({
			state: "loading",
			message: "Creating app…"
		});
		try {
			const response = await client.fetch("/api/apps/create", {
				method: "POST",
				body: JSON.stringify({
					intent,
					editTarget: createEditTarget.trim() || void 0
				})
			});
			if (!mountedRef.current) return;
			setCreateStatus({ state: "idle" });
			setCreateIntent("");
			setCreateEditTarget("");
			setShowCreate(false);
			setActionNotice(response.message ?? "App creation started.", response.ok === false ? "error" : "success", 4500);
			await refresh();
		} catch (err) {
			if (!mountedRef.current) return;
			setCreateStatus({
				state: "error",
				message: err instanceof Error ? err.message : "Failed to create app."
			});
		}
	}, [
		createEditTarget,
		createIntent,
		refresh,
		setActionNotice
	]);
	const handleLoadSubmit = useCallback(async (event) => {
		event.preventDefault();
		const directory = loadDirectory.trim();
		if (!directory) return;
		setLoadStatus({ state: "loading" });
		try {
			const response = await client.fetch("/api/apps/load-from-directory", {
				method: "POST",
				body: JSON.stringify({ directory })
			});
			if (!mountedRef.current) return;
			setLoadStatus({ state: "idle" });
			setLoadDirectory("");
			setShowLoad(false);
			const count = response.loaded ?? response.count ?? 0;
			setActionNotice(response.message ?? `Loaded ${count} app${count === 1 ? "" : "s"}.`, response.ok === false ? "error" : "success", 4e3);
			await refresh();
		} catch (err) {
			if (!mountedRef.current) return;
			setLoadStatus({
				state: "error",
				message: err instanceof Error ? err.message : "Failed to load directory."
			});
		}
	}, [
		loadDirectory,
		refresh,
		setActionNotice
	]);
	const isCreating = createStatus.state === "loading";
	const isLoading = loadStatus.state === "loading";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					(0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						size: "sm",
						variant: "default",
						className: "h-8 px-3 text-xs",
						onClick: () => {
							setShowCreate((v) => !v);
							setShowLoad(false);
						},
						children: t("settings.sections.apps.createNew", { defaultValue: "Create new app" })
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						size: "sm",
						variant: "outline",
						className: "h-8 px-3 text-xs",
						onClick: () => {
							setShowLoad((v) => !v);
							setShowCreate(false);
						},
						children: t("settings.sections.apps.loadFromDirectory", { defaultValue: "Load from directory" })
					}),
					(0, import_jsx_runtime.jsx)("div", { className: "flex-1" }),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "inline-flex items-center gap-1.5 text-2xs text-muted",
						children: [(0, import_jsx_runtime.jsx)(Checkbox, {
							checked: verifyOnRelaunch,
							onCheckedChange: (checked) => setVerifyOnRelaunch(!!checked),
							"aria-label": t("settings.sections.apps.verifyOnRelaunchLabel", { defaultValue: "Verify on relaunch" })
						}), (0, import_jsx_runtime.jsx)("span", { children: t("settings.sections.apps.verifyOnRelaunch", { defaultValue: "Verify on relaunch" }) })]
					})
				]
			}),
			showCreate ? (0, import_jsx_runtime.jsxs)("form", {
				className: "space-y-2 rounded-md border border-border bg-card p-3",
				onSubmit: handleCreateSubmit,
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1",
						children: [(0, import_jsx_runtime.jsx)("label", {
							className: "text-xs font-medium text-txt",
							htmlFor: "apps-create-intent",
							children: t("settings.sections.apps.intentLabel", { defaultValue: "What should the app do?" })
						}), (0, import_jsx_runtime.jsx)("textarea", {
							id: "apps-create-intent",
							rows: 3,
							value: createIntent,
							disabled: isCreating,
							onChange: (e) => setCreateIntent(e.target.value),
							className: "block w-full resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-txt focus:border-accent focus:outline-none disabled:opacity-50",
							placeholder: t("settings.sections.apps.intentPlaceholder", { defaultValue: "Describe the experience you want — e.g. a vibe coder for prototyping web apps with Tailwind." })
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1",
						children: [(0, import_jsx_runtime.jsx)("label", {
							className: "text-xs font-medium text-txt",
							htmlFor: "apps-create-edit-target",
							children: t("settings.sections.apps.basedOnLabel", { defaultValue: "Based on existing app (optional)" })
						}), (0, import_jsx_runtime.jsxs)("select", {
							id: "apps-create-edit-target",
							value: createEditTarget,
							disabled: isCreating,
							onChange: (e) => setCreateEditTarget(e.target.value),
							className: "block w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-txt focus:border-accent focus:outline-none disabled:opacity-50",
							children: [(0, import_jsx_runtime.jsx)("option", {
								value: "",
								children: t("settings.sections.apps.basedOnNone", { defaultValue: "Start from scratch" })
							}), installed.map((app) => (0, import_jsx_runtime.jsxs)("option", {
								value: app.name,
								children: [
									app.displayName,
									" (",
									app.name,
									")"
								]
							}, app.name))]
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2 pt-1",
						children: [
							(0, import_jsx_runtime.jsx)(Button, {
								type: "submit",
								size: "sm",
								variant: "default",
								className: "h-7 px-3 text-xs",
								disabled: isCreating || createIntent.trim().length === 0,
								children: isCreating ? (0, import_jsx_runtime.jsxs)("span", {
									className: "inline-flex items-center gap-1",
									children: [(0, import_jsx_runtime.jsx)(Loader2, {
										className: "h-3.5 w-3.5 animate-spin",
										"aria-hidden": true
									}), (0, import_jsx_runtime.jsx)("span", { children: createStatus.state === "loading" ? createStatus.message ?? "Working…" : "Working…" })]
								}) : t("common.create", { defaultValue: "Create" })
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								type: "button",
								size: "sm",
								variant: "ghost",
								className: "h-7 px-3 text-xs text-muted",
								onClick: () => {
									setShowCreate(false);
									setCreateIntent("");
									setCreateEditTarget("");
									setCreateStatus({ state: "idle" });
								},
								disabled: isCreating,
								children: t("common.cancel", { defaultValue: "Cancel" })
							}),
							createStatus.state === "error" ? (0, import_jsx_runtime.jsx)("span", {
								className: "text-2xs text-danger",
								children: createStatus.message
							}) : null
						]
					})
				]
			}) : null,
			showLoad ? (0, import_jsx_runtime.jsxs)("form", {
				className: "space-y-2 rounded-md border border-border bg-card p-3",
				onSubmit: handleLoadSubmit,
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)("label", {
						className: "text-xs font-medium text-txt",
						htmlFor: "apps-load-directory",
						children: t("settings.sections.apps.directoryLabel", { defaultValue: "Directory path" })
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "apps-load-directory",
						type: "text",
						value: loadDirectory,
						disabled: isLoading,
						onChange: (e) => setLoadDirectory(e.target.value),
						placeholder: "/Users/me/code/my-app",
						className: "h-8 text-xs"
					})]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2 pt-1",
					children: [
						(0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							size: "sm",
							variant: "default",
							className: "h-7 px-3 text-xs",
							disabled: isLoading || loadDirectory.trim().length === 0,
							children: isLoading ? (0, import_jsx_runtime.jsxs)("span", {
								className: "inline-flex items-center gap-1",
								children: [(0, import_jsx_runtime.jsx)(Loader2, {
									className: "h-3.5 w-3.5 animate-spin",
									"aria-hidden": true
								}), (0, import_jsx_runtime.jsx)("span", { children: t("common.loading", { defaultValue: "Loading…" }) })]
							}) : t("settings.sections.apps.loadButton", { defaultValue: "Load" })
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							size: "sm",
							variant: "ghost",
							className: "h-7 px-3 text-xs text-muted",
							onClick: () => {
								setShowLoad(false);
								setLoadDirectory("");
								setLoadStatus({ state: "idle" });
							},
							disabled: isLoading,
							children: t("common.cancel", { defaultValue: "Cancel" })
						}),
						loadStatus.state === "error" ? (0, import_jsx_runtime.jsx)("span", {
							className: "text-2xs text-danger",
							children: loadStatus.message
						}) : null
					]
				})]
			}) : null,
			listStatus.state === "loading" ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-1 py-3 text-xs text-muted",
				children: [(0, import_jsx_runtime.jsx)(Loader2, {
					className: "h-3.5 w-3.5 animate-spin",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("span", { children: t("settings.sections.apps.loadingApps", { defaultValue: "Loading apps…" }) })]
			}) : listStatus.state === "error" ? (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger",
				children: listStatus.message
			}) : installed.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-md border border-border bg-card px-3 py-4 text-center text-xs text-muted",
				children: t("settings.sections.apps.empty", { defaultValue: "No apps installed yet. Click 'Create new app' to scaffold one." })
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "overflow-x-auto rounded-md border border-border",
				children: (0, import_jsx_runtime.jsxs)("table", {
					className: "w-full text-left text-xs",
					children: [(0, import_jsx_runtime.jsx)("thead", {
						className: "bg-bg-hover",
						children: (0, import_jsx_runtime.jsxs)("tr", { children: [
							(0, import_jsx_runtime.jsx)("th", {
								className: HEAD_CELL_CLASS,
								children: t("settings.sections.apps.col.name", { defaultValue: "App" })
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: HEAD_CELL_CLASS,
								children: t("settings.sections.apps.col.id", { defaultValue: "ID" })
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: HEAD_CELL_CLASS,
								children: t("settings.sections.apps.col.version", { defaultValue: "Version" })
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: HEAD_CELL_CLASS,
								children: t("settings.sections.apps.col.runs", { defaultValue: "Runs" })
							}),
							(0, import_jsx_runtime.jsx)("th", {
								className: `${HEAD_CELL_CLASS} text-right`,
								children: t("settings.sections.apps.col.actions", { defaultValue: "Actions" })
							})
						] })
					}), (0, import_jsx_runtime.jsx)("tbody", { children: installed.map((app) => {
						const appRuns = runsByName.get(app.name) ?? [];
						const running = appRuns.length > 0;
						const busy = busyApp === app.name;
						return (0, import_jsx_runtime.jsxs)("tr", {
							className: "border-t border-border/60 hover:bg-bg-hover/40",
							"data-testid": `apps-mgmt-row-${app.name}`,
							children: [
								(0, import_jsx_runtime.jsx)("td", {
									className: `${BODY_CELL_CLASS} font-medium text-txt`,
									children: app.displayName
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: `${BODY_CELL_CLASS} font-mono text-2xs text-muted`,
									children: app.name
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: `${BODY_CELL_CLASS} text-2xs text-muted`,
									children: app.version || "—"
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: BODY_CELL_CLASS,
									children: running ? (0, import_jsx_runtime.jsxs)("span", {
										className: "inline-flex items-center rounded-full bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok",
										children: [
											appRuns.length,
											" ",
											appRuns.length === 1 ? "run" : "runs"
										]
									}) : (0, import_jsx_runtime.jsx)("span", {
										className: "text-2xs text-muted",
										children: "—"
									})
								}),
								(0, import_jsx_runtime.jsx)("td", {
									className: `${BODY_CELL_CLASS} text-right`,
									children: (0, import_jsx_runtime.jsxs)("div", {
										className: "inline-flex items-center gap-1",
										children: [
											(0, import_jsx_runtime.jsx)(Button, {
												type: "button",
												size: "sm",
												variant: "ghost",
												className: "h-7 px-2 text-xs",
												disabled: busy,
												onClick: () => void handleLaunch(app),
												title: t("settings.sections.apps.launch", { defaultValue: "Launch" }),
												"aria-label": `Launch ${app.displayName}`,
												children: (0, import_jsx_runtime.jsx)(Play, {
													className: "h-3.5 w-3.5",
													"aria-hidden": true
												})
											}),
											(0, import_jsx_runtime.jsx)(Button, {
												type: "button",
												size: "sm",
												variant: "ghost",
												className: "h-7 px-2 text-xs",
												disabled: busy,
												onClick: () => void handleRelaunch(app),
												title: t("settings.sections.apps.relaunch", { defaultValue: "Relaunch" }),
												"aria-label": `Relaunch ${app.displayName}`,
												children: (0, import_jsx_runtime.jsx)(RotateCw, {
													className: "h-3.5 w-3.5",
													"aria-hidden": true
												})
											}),
											(0, import_jsx_runtime.jsx)(Button, {
												type: "button",
												size: "sm",
												variant: "ghost",
												className: "h-7 px-2 text-xs",
												disabled: busy,
												onClick: () => void handleEdit(app),
												children: t("settings.sections.apps.edit", { defaultValue: "Edit" })
											}),
											running ? (0, import_jsx_runtime.jsx)(Button, {
												type: "button",
												size: "sm",
												variant: "ghost",
												className: "h-7 px-2 text-xs text-danger hover:text-danger",
												disabled: busy,
												onClick: () => void handleStop(app),
												title: t("settings.sections.apps.stop", { defaultValue: "Stop" }),
												"aria-label": `Stop ${app.displayName}`,
												children: (0, import_jsx_runtime.jsx)(Square, {
													className: "h-3.5 w-3.5",
													"aria-hidden": true
												})
											}) : null
										]
									})
								})
							]
						}, app.name);
					}) })]
				})
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/CapabilitiesSection.js
function CapabilitiesSection() {
	const { walletEnabled, browserEnabled, computerUseEnabled, setState, t } = useApp();
	const [autoTrainingConfig, setAutoTrainingConfig] = useState(null);
	const [autoTrainingAvailable, setAutoTrainingAvailable] = useState(null);
	const [autoTrainingLoading, setAutoTrainingLoading] = useState(true);
	const [autoTrainingSaving, setAutoTrainingSaving] = useState(false);
	const refreshAutoTraining = useCallback(async () => {
		setAutoTrainingLoading(true);
		try {
			const [configResponse, statusResponse] = await Promise.all([client.fetch("/api/training/auto/config"), client.fetch("/api/training/auto/status")]);
			setAutoTrainingConfig(configResponse.config);
			setAutoTrainingAvailable(statusResponse.serviceRegistered !== false);
		} catch {
			setAutoTrainingConfig(null);
			setAutoTrainingAvailable(false);
		} finally {
			setAutoTrainingLoading(false);
		}
	}, []);
	useEffect(() => {
		refreshAutoTraining();
	}, [refreshAutoTraining]);
	const handleAutoTrainingChange = useCallback(async (checked) => {
		if (!autoTrainingConfig || autoTrainingAvailable === false) return;
		const nextConfig = {
			...autoTrainingConfig,
			autoTrain: !!checked
		};
		setAutoTrainingConfig(nextConfig);
		setAutoTrainingSaving(true);
		try {
			setAutoTrainingConfig((await client.fetch("/api/training/auto/config", {
				method: "POST",
				body: JSON.stringify(nextConfig)
			})).config);
			setAutoTrainingAvailable(true);
		} catch {
			setAutoTrainingConfig(autoTrainingConfig);
		} finally {
			setAutoTrainingSaving(false);
		}
	}, [autoTrainingAvailable, autoTrainingConfig]);
	const autoTrainingDisabled = autoTrainingLoading || autoTrainingSaving || !autoTrainingConfig || autoTrainingAvailable === false;
	const autoTrainingStatus = autoTrainingLoading || autoTrainingSaving ? "loading" : autoTrainingAvailable === false ? "unavailable" : null;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsx)(CapabilityRow, {
				label: t("nav.wallet", { defaultValue: "Wallet" }),
				children: (0, import_jsx_runtime.jsx)(Switch, {
					checked: walletEnabled,
					onCheckedChange: (checked) => setState("walletEnabled", !!checked),
					"aria-label": t("settings.sections.wallet.enableLabel", { defaultValue: "Enable Wallet" })
				})
			}),
			(0, import_jsx_runtime.jsx)(CapabilityRow, {
				label: t("nav.browser", { defaultValue: "Browser" }),
				children: (0, import_jsx_runtime.jsx)(Switch, {
					checked: browserEnabled,
					onCheckedChange: (checked) => setState("browserEnabled", !!checked),
					"aria-label": t("settings.sections.capabilities.browserLabel", { defaultValue: "Enable Browser" })
				})
			}),
			(0, import_jsx_runtime.jsx)(CapabilityRow, {
				label: t("settings.sections.capabilities.computerUseName", { defaultValue: "Computer Use" }),
				hint: computerUseEnabled ? t("settings.sections.capabilities.computerUseHint", { defaultValue: "Accessibility and Screen Recording permissions are required for computer use." }) : null,
				children: (0, import_jsx_runtime.jsx)(Switch, {
					checked: computerUseEnabled,
					onCheckedChange: (checked) => setState("computerUseEnabled", !!checked),
					"aria-label": t("settings.sections.capabilities.computerUseLabel", { defaultValue: "Enable Computer Use" })
				})
			}),
			(0, import_jsx_runtime.jsx)(CapabilityRow, {
				label: t("settings.sections.capabilities.autoTrainingName", { defaultValue: "Auto-training" }),
				status: autoTrainingStatus,
				children: (0, import_jsx_runtime.jsx)(Switch, {
					checked: autoTrainingConfig?.autoTrain ?? false,
					disabled: autoTrainingDisabled,
					onCheckedChange: handleAutoTrainingChange,
					"aria-label": t("settings.sections.capabilities.autoTrainingLabel", { defaultValue: "Enable Auto-training" })
				})
			})
		]
	});
}
function CapabilityRow({ children, hint, label, status }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center justify-between gap-4",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "truncate font-medium text-sm",
					children: label
				}), (0, import_jsx_runtime.jsx)(CapabilityStatusIcon, { status })]
			}), hint ? (0, import_jsx_runtime.jsx)("div", {
				className: "mt-1 text-2xs text-muted",
				children: hint
			}) : null]
		}), children]
	});
}
function CapabilityStatusIcon({ status }) {
	if (status === "loading") return (0, import_jsx_runtime.jsx)("span", {
		className: "inline-flex text-muted",
		title: "Loading",
		role: "status",
		"aria-label": "Loading",
		children: (0, import_jsx_runtime.jsx)(Loader2, {
			className: "h-3.5 w-3.5 animate-spin",
			"aria-hidden": true
		})
	});
	if (status === "unavailable") return (0, import_jsx_runtime.jsx)("span", {
		className: "inline-flex text-warn",
		title: "Unavailable",
		role: "img",
		"aria-label": "Unavailable",
		children: (0, import_jsx_runtime.jsx)(AlertTriangle, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		})
	});
	return null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/permissions/PermissionIcon.js
function PermissionIcon({ icon }) {
	return (0, import_jsx_runtime.jsx)("span", {
		className: "text-base",
		children: {
			cursor: (0, import_jsx_runtime.jsx)(MousePointer2, { className: "w-4 h-4" }),
			monitor: (0, import_jsx_runtime.jsx)(Monitor, { className: "w-4 h-4" }),
			mic: (0, import_jsx_runtime.jsx)(Mic, { className: "w-4 h-4" }),
			camera: (0, import_jsx_runtime.jsx)(Camera, { className: "w-4 h-4" }),
			terminal: (0, import_jsx_runtime.jsx)(Terminal, { className: "w-4 h-4" }),
			"shield-ban": (0, import_jsx_runtime.jsx)(ShieldBan, { className: "w-4 h-4" })
		}[icon] ?? (0, import_jsx_runtime.jsx)(Settings, { className: "w-4 h-4" })
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/permissions/StreamingPermissions.js
const MEDIA_PERMISSIONS = [
	{
		id: "camera",
		name: "Camera",
		nameKey: "permissionssection.streaming.camera.name",
		description: "Stream video to your agent for vision tasks",
		descriptionKey: "permissionssection.streaming.camera.description",
		icon: "camera"
	},
	{
		id: "microphone",
		name: "Microphone",
		nameKey: "permissionssection.streaming.microphone.name",
		description: "Stream audio for voice interaction with your agent",
		descriptionKey: "permissionssection.streaming.microphone.description",
		icon: "mic"
	},
	{
		id: "screen",
		name: "Screen",
		nameKey: "permissionssection.streaming.screen.name",
		description: "Share your screen with your agent",
		descriptionKey: "permissionssection.streaming.screen.description",
		icon: "monitor",
		modes: ["web"]
	}
];
function translateWithFallback$1(t, key, fallback) {
	const value = t(key);
	return !value || value === key ? fallback : value;
}
function getCameraPermissionPlugin() {
	const cap = globalThis.Capacitor;
	if (!cap?.Plugins) return null;
	return cap.Plugins.ElizaCamera ?? null;
}
async function checkMobilePermissions() {
	const states = {};
	const plugin = getCameraPermissionPlugin();
	if (!plugin?.checkPermissions) return states;
	try {
		const result = await plugin.checkPermissions();
		states.camera = result.camera;
		states.microphone = result.microphone;
	} catch (err) {
		console.error("Failed to check mobile permissions:", err);
	}
	return states;
}
async function checkWebPermissions() {
	const states = {};
	states.screen = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" ? "prompt" : "unknown";
	try {
		if (navigator.permissions) {
			const [cameraPermission, microphonePermission] = await Promise.all([navigator.permissions.query({ name: "camera" }), navigator.permissions.query({ name: "microphone" })]);
			states.camera = cameraPermission.state;
			states.microphone = microphonePermission.state;
		}
	} catch {}
	return states;
}
function webPermissionErrorMessage(id, err) {
	const label = id === "camera" ? "Camera" : id === "microphone" ? "Microphone" : "Screen";
	const device = label.toLowerCase();
	const name = err instanceof DOMException ? err.name : "";
	if (name === "NotAllowedError" || name === "PermissionDeniedError") return `${label} is blocked for this site. Allow it in browser site settings, then try again.`;
	if (name === "NotFoundError" || name === "DevicesNotFoundError") return `No ${device} source was found.`;
	if (id === "screen" && name === "NotSupportedError") return "Screen sharing is not available in this browser.";
	if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
	return `Could not request ${device} permission.`;
}
function useStreamingPermissions(mode) {
	const [permStates, setPermStates] = useState({});
	const [permissionErrors, setPermissionErrors] = useState({});
	const [requestingId, setRequestingId] = useState(null);
	const [checking, setChecking] = useState(true);
	const checkPermissions = useCallback(async () => {
		if (mode === "mobile") return checkMobilePermissions();
		return checkWebPermissions();
	}, [mode]);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			setChecking(true);
			const nextStates = await checkPermissions();
			if (!cancelled) {
				setPermStates(nextStates);
				setChecking(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [checkPermissions]);
	return {
		checking,
		permissionErrors,
		permStates,
		requestPermission: useCallback(async (id) => {
			setRequestingId(id);
			setPermissionErrors((prev) => {
				const next = { ...prev };
				delete next[id];
				return next;
			});
			if (mode === "mobile") {
				try {
					const plugin = getCameraPermissionPlugin();
					if (!plugin?.requestPermissions) return;
					const result = await plugin.requestPermissions();
					setPermStates((prev) => ({
						...prev,
						camera: result.camera,
						microphone: result.microphone
					}));
				} catch (err) {
					console.error("Failed to request mobile permission:", err);
					setPermissionErrors((prev) => ({
						...prev,
						[id]: "Could not request device permissions."
					}));
				} finally {
					setRequestingId(null);
				}
				return;
			}
			try {
				if (!navigator.mediaDevices) throw new Error("Media devices are not available in this browser.");
				if (id === "camera") {
					(await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((track) => {
						track.stop();
					});
					setPermStates((prev) => ({
						...prev,
						camera: "granted"
					}));
					return;
				}
				if (id === "microphone") {
					(await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => {
						track.stop();
					});
					setPermStates((prev) => ({
						...prev,
						microphone: "granted"
					}));
					return;
				}
				if (id === "screen") {
					if (typeof navigator.mediaDevices.getDisplayMedia !== "function") throw new DOMException("Screen sharing is not available.", "NotSupportedError");
					(await navigator.mediaDevices.getDisplayMedia({ video: true })).getTracks().forEach((track) => {
						track.stop();
					});
					setPermStates((prev) => ({
						...prev,
						screen: "granted"
					}));
				}
			} catch (err) {
				console.error(`Failed to request browser ${id} permission:`, err);
				setPermStates((prev) => ({
					...prev,
					[id]: "denied"
				}));
				setPermissionErrors((prev) => ({
					...prev,
					[id]: webPermissionErrorMessage(id, err)
				}));
			} finally {
				setRequestingId(null);
			}
		}, [mode]),
		requestingId
	};
}
function getBadgeTone(state) {
	if (state === "granted") return "success";
	if (state === "denied") return "danger";
	return "warning";
}
function getBadgeLabel(state) {
	if (state === "granted") return "Granted";
	if (state === "denied") return "Denied";
	return "Not Set";
}
function StreamingPermissionsSettingsView({ description, mode, testId, title }) {
	const { t } = useApp();
	const { checking, permissionErrors, permStates, requestPermission, requestingId } = useStreamingPermissions(mode);
	if (checking) return (0, import_jsx_runtime.jsx)("div", {
		className: "text-center py-6 text-muted text-xs",
		children: translateWithFallback$1(t, "permissionssection.LoadingPermissions", "Loading permissions...")
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "space-y-6",
		"data-testid": testId,
		children: (0, import_jsx_runtime.jsxs)("div", { children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 mb-3",
				children: [(0, import_jsx_runtime.jsx)(Cloud, { className: "w-4 h-4 text-accent" }), (0, import_jsx_runtime.jsx)("div", {
					className: "font-bold text-sm",
					children: title
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-xs-tight text-muted mb-3",
				children: description
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "border border-border bg-card",
				children: MEDIA_PERMISSIONS.filter((def) => !def.modes?.includes(mode)).map((def) => {
					const status = permStates[def.id] ?? "unknown";
					const isGranted = status === "granted";
					const isRequesting = requestingId === def.id;
					const name = translateWithFallback$1(t, def.nameKey, def.name);
					const error = permissionErrors[def.id] ?? (status === "denied" ? `${name} is blocked for this site. Allow it in browser site settings, then try again.` : null);
					const description = translateWithFallback$1(t, def.descriptionKey, def.description);
					return (0, import_jsx_runtime.jsxs)("div", {
						"data-permission-id": def.id,
						className: "flex items-center gap-3 py-2.5 px-3",
						children: [
							(0, import_jsx_runtime.jsx)(PermissionIcon, { icon: def.icon }),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "flex-1 min-w-0",
								children: [
									(0, import_jsx_runtime.jsxs)("div", {
										className: "flex items-center gap-2",
										children: [(0, import_jsx_runtime.jsx)("span", {
											className: "font-semibold text-sm",
											children: name
										}), (0, import_jsx_runtime.jsx)(StatusBadge, {
											label: translateWithFallback$1(t, status === "granted" ? "permissionssection.badge.granted" : status === "denied" ? "permissionssection.badge.denied" : "permissionssection.badge.notDetermined", getBadgeLabel(status)),
											variant: getBadgeTone(status),
											withDot: true,
											className: "rounded-full font-semibold"
										})]
									}),
									(0, import_jsx_runtime.jsx)("div", {
										className: "text-xs-tight text-muted mt-0.5 truncate",
										children: description
									}),
									error ? (0, import_jsx_runtime.jsx)("div", {
										className: "mt-1 text-xs-tight text-danger",
										children: error
									}) : null
								]
							}),
							!isGranted ? (0, import_jsx_runtime.jsxs)(Button, {
								variant: "default",
								size: "sm",
								className: "h-auto text-xs-tight py-1 px-2.5",
								disabled: isRequesting,
								onClick: () => void requestPermission(def.id),
								"aria-label": `${translateWithFallback$1(t, "permissionssection.Grant", "Grant")} ${name}`,
								children: [isRequesting ? (0, import_jsx_runtime.jsx)(Loader2, {
									className: "h-3 w-3 animate-spin",
									"aria-hidden": true
								}) : null, isRequesting ? translateWithFallback$1(t, "permissionssection.Requesting", "Requesting") : translateWithFallback$1(t, "permissionssection.Grant", "Grant")]
							}) : (0, import_jsx_runtime.jsx)(Check, { className: "w-4 h-4 text-ok" })
						]
					}, def.id);
				})
			})
		] })
	});
}
function StreamingPermissionsOnboardingView({ description, mode, onContinue, onBack, testId, title }) {
	const { t } = useApp();
	const { checking, permStates, requestPermission, requestingId } = useStreamingPermissions(mode);
	if (checking) return (0, import_jsx_runtime.jsx)("div", {
		className: "text-center py-8",
		children: (0, import_jsx_runtime.jsx)("div", {
			className: "text-sm text-[var(--onboarding-text-primary)]",
			children: translateWithFallback$1(t, "permissionssection.CheckingPermissions", "Checking permissions...")
		})
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		"data-testid": testId,
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-5 text-center",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "mb-2 text-xl font-bold text-[var(--onboarding-text-strong)]",
					children: title
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "text-sm text-[var(--onboarding-text-primary)]",
					children: description
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "mb-6 space-y-2.5",
				children: MEDIA_PERMISSIONS.filter((def) => !def.modes?.includes(mode)).map((def) => {
					const isGranted = permStates[def.id] === "granted";
					const isRequesting = requestingId === def.id;
					const name = translateWithFallback$1(t, def.nameKey, def.name);
					const description = translateWithFallback$1(t, def.descriptionKey, def.description);
					return (0, import_jsx_runtime.jsxs)("div", {
						"data-permission-id": def.id,
						className: `flex items-center gap-4 rounded-[16px] border px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${isGranted ? "border-ok bg-[color:color-mix(in_srgb,var(--ok)_16%,var(--onboarding-card-bg)_84%)]" : "border-[var(--onboarding-card-border)] bg-[var(--onboarding-card-bg)]"}`,
						children: [
							(0, import_jsx_runtime.jsx)(PermissionIcon, { icon: def.icon }),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "flex-1",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-sm font-semibold text-[var(--onboarding-text-strong)]",
									children: name
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "text-xs-tight text-[var(--onboarding-text-subtle)]",
									children: description
								})]
							}),
							isGranted ? (0, import_jsx_runtime.jsx)(Check, { className: "w-4 h-4 text-ok" }) : (0, import_jsx_runtime.jsx)(Button, {
								variant: "default",
								size: "sm",
								className: "h-auto text-xs py-1.5 px-3",
								disabled: isRequesting,
								onClick: () => void requestPermission(def.id),
								"aria-label": `${translateWithFallback$1(t, "permissionssection.Grant", "Grant")} ${name}`,
								children: isRequesting ? translateWithFallback$1(t, "permissionssection.Requesting", "Requesting") : translateWithFallback$1(t, "permissionssection.Grant", "Grant")
							})
						]
					}, def.id);
				})
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex justify-between items-center gap-6 mt-[18px] pt-3.5",
				children: [onBack ? (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "text-2xs text-[rgba(240,238,250,0.62)] tracking-[0.15em] uppercase cursor-pointer no-underline transition-colors duration-300 p-0 hover:text-[rgba(240,238,250,0.9)]",
					style: { textShadow: "0 1px 8px rgba(3,5,10,0.45)" },
					onClick: () => onBack(),
					children: translateWithFallback$1(t, "onboarding.back", "Back")
				}) : (0, import_jsx_runtime.jsx)("span", {}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					"data-testid": "permissions-onboarding-continue",
					className: "group relative inline-flex items-center justify-center gap-[8px] px-[32px] py-[12px] min-h-touch bg-[rgba(240,185,11,0.18)] border border-[rgba(240,185,11,0.35)] rounded-sm text-[var(--onboarding-accent-foreground)] text-xs-tight font-semibold tracking-[0.18em] uppercase cursor-pointer transition-all duration-300 overflow-hidden hover:bg-[rgba(240,185,11,0.28)] hover:border-[rgba(240,185,11,0.6)] disabled:opacity-40 disabled:cursor-not-allowed",
					onClick: (e) => {
						if (e?.currentTarget) {
							const rect = e.currentTarget.getBoundingClientRect();
							const circle = document.createElement("span");
							const diameter = Math.max(rect.width, rect.height);
							circle.style.width = circle.style.height = `${diameter}px`;
							circle.style.left = `${e.clientX - rect.left - diameter / 2}px`;
							circle.style.top = `${e.clientY - rect.top - diameter / 2}px`;
							circle.className = "absolute rounded-full bg-[rgba(240,185,11,0.3)] transform scale-0 animate-[onboarding-ripple-expand_0.6s_ease-out_forwards] pointer-events-none";
							e.currentTarget.appendChild(circle);
							setTimeout(() => circle.remove(), 600);
						}
						onContinue();
					},
					children: translateWithFallback$1(t, "onboarding.savedMyKeys", "Continue")
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/permission-types.js
const SYSTEM_PERMISSIONS = [
	{
		id: "accessibility",
		name: "Accessibility",
		nameKey: "permissionssection.permission.accessibility.name",
		description: "Control mouse, keyboard, and interact with other applications",
		descriptionKey: "permissionssection.permission.accessibility.description",
		icon: "cursor",
		platforms: ["darwin"],
		requiredForFeatures: ["computeruse", "browser"]
	},
	{
		id: "screen-recording",
		name: "Screen Recording",
		nameKey: "permissionssection.permission.screenRecording.name",
		description: "Capture screen content for screenshots and vision",
		descriptionKey: "permissionssection.permission.screenRecording.description",
		icon: "monitor",
		platforms: ["darwin"],
		requiredForFeatures: ["computeruse", "vision"]
	},
	{
		id: "microphone",
		name: "Microphone",
		nameKey: "permissionssection.permission.microphone.name",
		description: "Voice input for talk mode and speech recognition",
		descriptionKey: "permissionssection.permission.microphone.description",
		icon: "mic",
		platforms: [
			"darwin",
			"win32",
			"linux"
		],
		requiredForFeatures: ["talkmode", "voice"]
	},
	{
		id: "camera",
		name: "Camera",
		nameKey: "permissionssection.permission.camera.name",
		description: "Video input for vision and video capture",
		descriptionKey: "permissionssection.permission.camera.description",
		icon: "camera",
		platforms: [
			"darwin",
			"win32",
			"linux"
		],
		requiredForFeatures: ["camera", "vision"]
	},
	{
		id: "shell",
		name: "Shell Access",
		nameKey: "permissionssection.permission.shell.name",
		description: "Execute terminal commands and scripts",
		descriptionKey: "permissionssection.permission.shell.description",
		icon: "terminal",
		platforms: [
			"darwin",
			"win32",
			"linux"
		],
		requiredForFeatures: ["shell"]
	},
	{
		id: "website-blocking",
		name: "Website Blocking",
		nameKey: "permissionssection.permission.websiteBlocking.name",
		description: "Edit the system hosts file to block distracting websites. This may require admin/root approval each time.",
		descriptionKey: "permissionssection.permission.websiteBlocking.description",
		icon: "shield-ban",
		platforms: [
			"darwin",
			"win32",
			"linux"
		],
		requiredForFeatures: ["website-blocker"]
	}
];
const CAPABILITIES = [
	{
		id: "browser",
		label: "Browser Control",
		labelKey: "permissionssection.capability.browser.label",
		description: "Automated web browsing and interaction",
		descriptionKey: "permissionssection.capability.browser.description",
		requiredPermissions: ["accessibility"]
	},
	{
		id: "computeruse",
		label: "Computer Use",
		labelKey: "permissionssection.capability.computerUse.label",
		description: "Full desktop control with mouse and keyboard",
		descriptionKey: "permissionssection.capability.computerUse.description",
		requiredPermissions: ["accessibility", "screen-recording"]
	},
	{
		id: "vision",
		label: "Vision",
		labelKey: "permissionssection.capability.vision.label",
		description: "Screen capture and visual analysis",
		descriptionKey: "permissionssection.capability.vision.description",
		requiredPermissions: ["screen-recording"]
	},
	{
		id: "coding-agent",
		label: "Task Agent Swarms",
		labelKey: "permissionssection.capability.codingAgent.label",
		description: "Orchestrate open-ended CLI task agents (Claude Code, Gemini CLI, Codex, Aider, Pi)",
		descriptionKey: "permissionssection.capability.codingAgent.description",
		requiredPermissions: []
	}
];
const PERMISSION_BADGE_LABELS = {
	granted: {
		tone: "success",
		labelKey: "permissionssection.badge.granted",
		defaultLabel: "Granted"
	},
	denied: {
		tone: "danger",
		labelKey: "permissionssection.badge.denied",
		defaultLabel: "Denied"
	},
	"not-determined": {
		tone: "warning",
		labelKey: "permissionssection.badge.notDetermined",
		defaultLabel: "Not Set"
	},
	restricted: {
		tone: "muted",
		labelKey: "permissionssection.badge.restricted",
		defaultLabel: "Restricted"
	},
	"not-applicable": {
		tone: "muted",
		labelKey: "permissionssection.badge.notApplicable",
		defaultLabel: "N/A"
	}
};
/** Reusable settings-panel Tailwind class names. */
const SETTINGS_PANEL_CLASSNAME = "rounded-2xl border border-border/60 bg-bg/40 p-4 space-y-4";
const SETTINGS_PANEL_HEADER_CLASSNAME = "flex flex-wrap items-start justify-between gap-3";
const SETTINGS_PANEL_ACTIONS_CLASSNAME = "flex items-center gap-2";
const SETTINGS_REFRESH_DELAYS_MS = [1500, 4e3];
function translateWithFallback(t, key, fallback) {
	const value = t(key);
	return !value || value === key ? fallback : value;
}
function getPermissionAction(t, id, status, canRequest, platform) {
	if (status === "granted" || status === "not-applicable") return null;
	const usesWindowsPrivacySettings = platform === "win32" && (id === "microphone" || id === "camera");
	if (status === "not-determined" && canRequest) {
		if (id === "website-blocking") {
			const label = platform === "ios" ? translateWithFallback(t, "permissionssection.OpenSettings", "Open Settings") : translateWithFallback(t, "permissionssection.RequestApproval", "Request Approval");
			return {
				ariaLabelPrefix: label,
				label,
				type: "request"
			};
		}
		const label = usesWindowsPrivacySettings ? translateWithFallback(t, "permissionssection.OpenPrivacySettings", "Open Privacy Settings") : id === "camera" ? translateWithFallback(t, "permissionssection.CheckAccess", "Check Access") : translateWithFallback(t, "permissionssection.Grant", "Grant");
		return {
			ariaLabelPrefix: label,
			label,
			type: usesWindowsPrivacySettings ? "settings" : "request"
		};
	}
	if (id === "website-blocking") {
		const label = platform === "ios" ? translateWithFallback(t, "permissionssection.OpenSettings", "Open Settings") : translateWithFallback(t, "permissionssection.OpenHostsFile", "Open Hosts File");
		return {
			ariaLabelPrefix: label,
			label,
			type: "settings"
		};
	}
	const label = translateWithFallback(t, "permissionssection.OpenSettings", "Open Settings");
	return {
		ariaLabelPrefix: label,
		label,
		type: "settings"
	};
}
function getPermissionBadge(t, id, status, platform) {
	if (status === "denied") {
		if (id === "shell") return {
			tone: "danger",
			label: translateWithFallback(t, "permissionssection.badge.off", "Off")
		};
		if (id === "website-blocking") return {
			tone: "danger",
			label: translateWithFallback(t, "permissionssection.badge.needsAdmin", "Needs Admin")
		};
		if (platform === "darwin") return {
			tone: "danger",
			label: translateWithFallback(t, "permissionssection.badge.offInSettings", "Off in Settings")
		};
	}
	if (status === "not-determined") {
		if (id === "website-blocking") return {
			tone: "warning",
			label: translateWithFallback(t, "permissionssection.badge.needsApproval", "Needs Approval")
		};
		return {
			tone: "warning",
			label: translateWithFallback(t, "permissionssection.badge.notAsked", "Not Asked")
		};
	}
	const badge = PERMISSION_BADGE_LABELS[status];
	return {
		tone: badge.tone,
		label: translateWithFallback(t, badge.labelKey, badge.defaultLabel)
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/permission-controls.js
const RUNTIME_PERMISSION_IDS = ["website-blocking"];
const REQUIRED_PERMISSION_IDS = [
	"accessibility",
	"screen-recording",
	"microphone",
	"camera",
	"shell",
	"website-blocking"
];
const PERMISSION_STATUSES = [
	"granted",
	"denied",
	"not-determined",
	"restricted",
	"not-applicable"
];
function isRuntimePermissionId(id) {
	return RUNTIME_PERMISSION_IDS.includes(id);
}
function isRecord(value) {
	return Boolean(value) && typeof value === "object";
}
function isPermissionStatus(value) {
	return typeof value === "string" && PERMISSION_STATUSES.includes(value);
}
function isPermissionState(value, id) {
	return isRecord(value) && value.id === id && isPermissionStatus(value.status) && typeof value.canRequest === "boolean" && typeof value.lastChecked === "number";
}
function isAllPermissionsState(value) {
	return isRecord(value) && REQUIRED_PERMISSION_IDS.every((id) => isPermissionState(value[id], id));
}
function mapRendererMediaPermissionState(state) {
	if (state === "granted") return "granted";
	if (state === "denied") return "denied";
	if (state === "prompt") return "not-determined";
	return null;
}
async function queryRendererMediaPermission(id) {
	if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
	try {
		return mapRendererMediaPermissionState((await navigator.permissions.query({ name: id }))?.state);
	} catch {
		return null;
	}
}
async function inferRendererMediaPermissionFromDevices(id) {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return null;
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		if (!Array.isArray(devices)) return null;
		const kind = id === "camera" ? "videoinput" : "audioinput";
		return devices.some((device) => device.kind === kind && Boolean(device.label?.trim())) ? "granted" : null;
	} catch {
		return null;
	}
}
async function probeRendererMediaPermission(id) {
	const queriedStatus = await queryRendererMediaPermission(id);
	if (queriedStatus === "granted" || queriedStatus === "denied") return queriedStatus;
	const inferredStatus = await inferRendererMediaPermissionFromDevices(id);
	if (inferredStatus) return inferredStatus;
	return queriedStatus;
}
async function reconcileRendererMediaPermissions(snapshot) {
	if (snapshot.platform === "win32") return snapshot;
	let nextPermissions = snapshot.permissions;
	let changed = false;
	for (const id of ["camera", "microphone"]) {
		const current = snapshot.permissions[id];
		if (!current || current.status === "restricted") continue;
		const rendererStatus = await probeRendererMediaPermission(id);
		if (!rendererStatus) continue;
		const nextCanRequest = rendererStatus === "not-determined";
		if (current.status === rendererStatus && current.canRequest === nextCanRequest) continue;
		if (!changed) {
			nextPermissions = { ...snapshot.permissions };
			changed = true;
		}
		nextPermissions[id] = {
			...current,
			status: rendererStatus,
			canRequest: nextCanRequest,
			lastChecked: Date.now()
		};
	}
	return changed ? {
		...snapshot,
		permissions: nextPermissions
	} : snapshot;
}
async function mergeRuntimePermissionsIntoSnapshot(snapshot) {
	let nextPermissions = snapshot.permissions;
	let changed = false;
	await Promise.all(RUNTIME_PERMISSION_IDS.map(async (id) => {
		try {
			const permission = await client.getPermission(id);
			if (!changed) {
				nextPermissions = { ...snapshot.permissions };
				changed = true;
			}
			nextPermissions[id] = permission;
		} catch {}
	}));
	return changed ? {
		...snapshot,
		permissions: nextPermissions
	} : snapshot;
}
function PermissionRow({ def, status, reason, platform, canRequest, onRequest, onOpenSettings, isShell, shellEnabled, onToggleShell }) {
	const { t } = useApp();
	const action = getPermissionAction(t, def.id, status, canRequest, platform);
	const badge = getPermissionBadge(t, def.id, status, platform);
	const name = translateWithFallback(t, def.nameKey, def.name);
	const description = translateWithFallback(t, def.descriptionKey, def.description);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 flex-1 items-start gap-3",
			children: [(0, import_jsx_runtime.jsx)(PermissionIcon, { icon: def.icon }), (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "font-semibold text-sm text-txt",
							children: name
						}), isShell && (0, import_jsx_runtime.jsx)("span", {
							className: "rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong",
							children: translateWithFallback(t, "permissionssection.LocalRuntime", "Local runtime")
						})]
					}),
					(0, import_jsx_runtime.jsx)(StatusBadge, {
						label: badge.label,
						variant: badge.tone,
						withDot: true,
						className: "rounded-full font-semibold"
					}),
					(0, import_jsx_runtime.jsx)("div", {
						className: "mt-1 text-xs-tight leading-5 text-muted",
						children: description
					}),
					reason && (0, import_jsx_runtime.jsx)("div", {
						className: "mt-1 text-xs-tight leading-5 text-muted-strong",
						children: reason
					})
				]
			})]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex w-full items-center justify-end gap-2 sm:w-auto",
			children: [isShell && onToggleShell && status !== "not-applicable" && (0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-bg-hover px-3",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "text-xs-tight font-medium text-muted-strong",
					children: shellEnabled ? translateWithFallback(t, "permissionssection.Enabled", "Enabled") : translateWithFallback(t, "permissionssection.Disabled", "Disabled")
				}), (0, import_jsx_runtime.jsx)(Switch, {
					checked: shellEnabled,
					onCheckedChange: onToggleShell,
					title: shellEnabled ? translateWithFallback(t, "permissionssection.DisableShellAccess", "Disable shell access") : translateWithFallback(t, "permissionssection.EnableShellAccess", "Enable shell access")
				})]
			}), !isShell && action && (0, import_jsx_runtime.jsx)(Button, {
				variant: "default",
				size: "sm",
				className: "min-h-10 rounded-xl px-3 text-xs-tight font-semibold",
				onClick: action.type === "request" ? onRequest : onOpenSettings,
				"aria-label": `${action.ariaLabelPrefix} ${name}`,
				children: action.label
			})]
		})]
	});
}
function CapabilityToggle({ cap, plugin, permissionsGranted, onToggle }) {
	const { t } = useApp();
	const enabled = plugin?.enabled ?? false;
	const available = plugin !== null;
	const canEnable = permissionsGranted && available;
	const label = translateWithFallback(t, cap.labelKey, cap.label);
	const description = translateWithFallback(t, cap.descriptionKey, cap.description);
	const toggleActionLabel = `${enabled ? translateWithFallback(t, "permissionssection.Disable", "Disable") : translateWithFallback(t, "permissionssection.Enable", "Enable")} ${label}`;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `flex flex-col gap-3 rounded-2xl border px-4 py-3 shadow-sm transition-colors sm:flex-row sm:items-center ${enabled ? "border-accent/30 bg-accent/10" : "border-border/60 bg-card/92"}`,
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex-1 min-w-0",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "font-semibold text-sm text-txt",
						children: label
					}),
					!available && (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong",
						children: translateWithFallback(t, "permissionssection.PluginUnavailable", "Plugin unavailable")
					}),
					!permissionsGranted && (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium text-warn",
						children: t("permissionssection.MissingPermissions")
					})
				]
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "mt-1 text-xs-tight leading-5 text-muted",
				children: description
			})]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "flex w-full justify-end sm:w-auto",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-bg-hover px-3",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "text-xs-tight font-medium text-muted-strong",
					children: enabled ? translateWithFallback(t, "permissionssection.Enabled", "Enabled") : translateWithFallback(t, "permissionssection.Disabled", "Disabled")
				}), (0, import_jsx_runtime.jsx)(Switch, {
					checked: enabled,
					onCheckedChange: onToggle,
					disabled: !canEnable,
					"aria-label": toggleActionLabel,
					title: !available ? translateWithFallback(t, "permissionssection.PluginNotAvailable", "Plugin not available") : !permissionsGranted ? translateWithFallback(t, "permissionssection.GrantRequiredPermissionsFirst", "Grant required permissions first") : enabled ? translateWithFallback(t, "permissionssection.Disable", "Disable") : translateWithFallback(t, "permissionssection.Enable", "Enable")
				})]
			})
		})]
	});
}
function useDesktopPermissionsState() {
	const [permissions, setPermissions] = useState(null);
	const [platform, setPlatform] = useState("unknown");
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [shellEnabled, setShellEnabled] = useState(true);
	const settingsRefreshTimersRef = useRef([]);
	const applySnapshot = useCallback((snapshot) => {
		setPermissions(snapshot.permissions);
		setPlatform(snapshot.platform);
		setShellEnabled(snapshot.shellEnabled);
	}, []);
	const clearScheduledSettingsRefreshes = useCallback(() => {
		if (typeof window === "undefined") {
			settingsRefreshTimersRef.current = [];
			return;
		}
		for (const timerId of settingsRefreshTimersRef.current) window.clearTimeout(timerId);
		settingsRefreshTimersRef.current = [];
	}, []);
	const loadPermissionsSnapshot = useCallback(async (forceRefresh = false) => {
		const [bridgedPermissions, bridgedShellEnabled, bridgedPlatform] = await Promise.all([
			invokeDesktopBridgeRequest({
				rpcMethod: "permissionsGetAll",
				ipcChannel: "permissions:getAll",
				params: forceRefresh ? { forceRefresh: true } : void 0
			}),
			invokeDesktopBridgeRequest({
				rpcMethod: "permissionsIsShellEnabled",
				ipcChannel: "permissions:isShellEnabled"
			}),
			invokeDesktopBridgeRequest({
				rpcMethod: "permissionsGetPlatform",
				ipcChannel: "permissions:getPlatform"
			})
		]);
		if (forceRefresh && bridgedPermissions === null) await client.refreshPermissions();
		const permissions = bridgedPermissions ?? await client.getPermissions();
		if (!isAllPermissionsState(permissions)) throw new Error("Invalid permissions payload.");
		const shellEnabled = bridgedShellEnabled === null ? await client.isShellEnabled() : bridgedShellEnabled;
		return reconcileRendererMediaPermissions(await mergeRuntimePermissionsIntoSnapshot({
			permissions,
			platform: bridgedPlatform ?? "unknown",
			shellEnabled
		}));
	}, []);
	const replaceSnapshot = useCallback(async (forceRefresh = false) => {
		const snapshot = await loadPermissionsSnapshot(forceRefresh);
		applySnapshot(snapshot);
		return snapshot;
	}, [applySnapshot, loadPermissionsSnapshot]);
	const scheduleSettingsRefreshes = useCallback(() => {
		if (typeof window === "undefined") return;
		clearScheduledSettingsRefreshes();
		for (const delayMs of SETTINGS_REFRESH_DELAYS_MS) {
			let timerId = 0;
			timerId = window.setTimeout(() => {
				settingsRefreshTimersRef.current = settingsRefreshTimersRef.current.filter((currentTimerId) => currentTimerId !== timerId);
				replaceSnapshot(true);
			}, delayMs);
			settingsRefreshTimersRef.current.push(timerId);
		}
	}, [clearScheduledSettingsRefreshes, replaceSnapshot]);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			try {
				const snapshot = await loadPermissionsSnapshot();
				if (!cancelled) applySnapshot(snapshot);
			} catch (err) {
				if (!cancelled) {
					console.error("Failed to load permissions:", err);
					setPermissions(null);
					setPlatform("unknown");
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [applySnapshot, loadPermissionsSnapshot]);
	useEffect(() => {
		return () => {
			clearScheduledSettingsRefreshes();
		};
	}, [clearScheduledSettingsRefreshes]);
	useEffect(() => {
		return subscribeDesktopBridgeEvent({
			rpcMessage: "permissionsChanged",
			ipcChannel: "permissions:changed",
			listener: () => {
				replaceSnapshot(true);
			}
		});
	}, [replaceSnapshot]);
	useEffect(() => {
		if (typeof document === "undefined" || typeof window === "undefined") return;
		const handleVisibilityOrFocus = () => {
			if (document.visibilityState === "hidden") return;
			replaceSnapshot(true);
		};
		window.addEventListener("focus", handleVisibilityOrFocus);
		document.addEventListener("visibilitychange", handleVisibilityOrFocus);
		return () => {
			window.removeEventListener("focus", handleVisibilityOrFocus);
			document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
		};
	}, [replaceSnapshot]);
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			return await replaceSnapshot(true);
		} catch (err) {
			console.error("Failed to refresh permissions:", err);
			return null;
		} finally {
			setRefreshing(false);
		}
	}, [replaceSnapshot]);
	const handleRequest = useCallback(async (id) => {
		try {
			if (isRuntimePermissionId(id)) {
				await client.requestPermission(id);
				const status = (await replaceSnapshot(true)).permissions[id]?.status;
				if (status && status !== "granted" && status !== "not-applicable") scheduleSettingsRefreshes();
				return;
			}
			if (await invokeDesktopBridgeRequest({
				rpcMethod: "permissionsRequest",
				ipcChannel: "permissions:request",
				params: { id }
			}) === null) await client.requestPermission(id);
			const status = (await replaceSnapshot(true)).permissions[id]?.status;
			if (status && status !== "granted" && status !== "not-applicable") scheduleSettingsRefreshes();
		} catch (err) {
			console.error("Failed to request permission:", err);
		}
	}, [replaceSnapshot, scheduleSettingsRefreshes]);
	return {
		handleOpenSettings: useCallback(async (id) => {
			try {
				if (isRuntimePermissionId(id)) {
					await client.openPermissionSettings(id);
					await replaceSnapshot(true);
					scheduleSettingsRefreshes();
					return;
				}
				if (await invokeDesktopBridgeRequest({
					rpcMethod: "permissionsOpenSettings",
					ipcChannel: "permissions:openSettings",
					params: { id }
				}) === null) await client.openPermissionSettings(id);
				await replaceSnapshot(true);
				scheduleSettingsRefreshes();
			} catch (err) {
				console.error("Failed to open settings:", err);
			}
		}, [replaceSnapshot, scheduleSettingsRefreshes]),
		handleRefresh,
		handleRequest,
		handleToggleShell: useCallback(async (enabled) => {
			try {
				const bridgeToggle = invokeDesktopBridgeRequest({
					rpcMethod: "permissionsSetShellEnabled",
					ipcChannel: "permissions:setShellEnabled",
					params: { enabled }
				});
				await Promise.allSettled([bridgeToggle, client.setShellEnabled(enabled)]);
				await replaceSnapshot(true);
			} catch (err) {
				console.error("Failed to toggle shell:", err);
			}
		}, [replaceSnapshot]),
		loading,
		permissions,
		platform,
		refreshing,
		shellEnabled
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/PermissionsSection.js
const PLATFORM_COPY = {
	darwin: {
		systemDescription: {
			key: "permissionssection.MacSystemPermissionsDescription",
			defaultValue: "Review the native permissions the app needs for desktop control, voice input, and visual analysis. macOS changes may require opening System Settings."
		},
		grantNote: {
			key: "permissionssection.MacGrantAccessNote",
			defaultValue: "macOS requires Accessibility permission for computer control. Open System Settings → Privacy & Security to grant access."
		},
		permissionReady: {
			key: "permissionssection.PermissionReadyNote",
			defaultValue: "All required permissions are ready. Continue when you're ready."
		},
		grantSubNote: {
			key: "permissionssection.PermissionGrantNote",
			defaultValue: "Granting now will request what can be approved immediately and open Settings for anything that must be enabled there."
		},
		onboardingIntro: {
			key: "permissionssection.GrantPermissionsTo",
			defaultValue: "Grant permissions to unlock desktop features."
		}
	},
	win32: {
		systemDescription: {
			key: "permissionssection.WindowsSystemPermissionsDescription",
			defaultValue: "Open Windows privacy settings for microphone and camera, then verify access by using those features in the app."
		},
		grantNote: {
			key: "permissionssection.WindowsGrantPermissionsNote",
			defaultValue: "Windows may not list the app as a named app here. Use Privacy settings to enable microphone and camera access, then test them in the app."
		},
		permissionReady: {
			key: "permissionssection.WindowsPermissionReadyNote",
			defaultValue: "Windows privacy settings are advisory here. Continue, then verify microphone and camera directly in the app."
		},
		grantSubNote: {
			key: "permissionssection.WindowsPermissionGrantNote",
			defaultValue: "This opens Windows privacy settings for microphone and camera. The app may not appear as a named app there; the real check is whether capture works back in the app."
		},
		onboardingIntro: {
			key: "permissionssection.WindowsGrantPermissionsTo",
			defaultValue: "Open Windows privacy settings to prepare microphone and camera access for desktop features."
		}
	},
	linux: {
		systemDescription: {
			key: "permissionssection.SystemPermissionsDescription",
			defaultValue: "Grant the runtime access it needs for voice input, camera capture, shell tasks, and desktop automation features."
		},
		grantNote: {
			key: "permissionssection.GrantPermissionsNote",
			defaultValue: "Grant permissions to enable features like voice input and computer control."
		},
		permissionReady: {
			key: "permissionssection.PermissionReadyNote",
			defaultValue: "All required permissions are ready. Continue when you're ready."
		},
		grantSubNote: {
			key: "permissionssection.PermissionGrantNote",
			defaultValue: "Granting now will request what can be approved immediately and open Settings for anything that must be enabled there."
		},
		onboardingIntro: {
			key: "permissionssection.GrantPermissionsTo",
			defaultValue: "Grant permissions to unlock desktop features."
		}
	}
};
function platformCopy(platform) {
	if (platform === "darwin") return PLATFORM_COPY.darwin;
	if (platform === "win32") return PLATFORM_COPY.win32;
	return PLATFORM_COPY.linux;
}
function MobilePermissionsView() {
	const { t } = useApp();
	const { appBlockerSettingsCard: AppBlockerSettingsCard, websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } = useBootConfig();
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-6",
		children: [
			(0, import_jsx_runtime.jsx)(StreamingPermissionsSettingsView, {
				mode: "mobile",
				testId: "mobile-permissions",
				title: t("permissionssection.StreamingPermissions", { defaultValue: "Streaming Permissions" }),
				description: t("permissionssection.MobileStreamingDesc", { defaultValue: "Your device streams camera, microphone, and screen to your Eliza Cloud agent for processing." })
			}),
			AppBlockerSettingsCard ? (0, import_jsx_runtime.jsx)(AppBlockerSettingsCard, { mode: "mobile" }) : null,
			WebsiteBlockerSettingsCard ? (0, import_jsx_runtime.jsx)(WebsiteBlockerSettingsCard, { mode: "mobile" }) : null
		]
	});
}
function WebPermissionsView() {
	const { t } = useApp();
	const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } = useBootConfig();
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-6",
		children: [(0, import_jsx_runtime.jsx)(StreamingPermissionsSettingsView, {
			mode: "web",
			testId: "web-permissions-info",
			title: t("permissionssection.BrowserPermissions", { defaultValue: "Browser Permissions" }),
			description: t("permissionssection.WebStreamingDesc", { defaultValue: "Grant browser access to your camera, microphone, and screen to stream to your agent." })
		}), WebsiteBlockerSettingsCard ? isLocalBrowserRuntime() ? (0, import_jsx_runtime.jsx)(LocalWebsiteBlockingCard, { WebsiteBlockerSettingsCard }) : (0, import_jsx_runtime.jsx)(WebsiteBlockerSettingsCard, { mode: "web" }) : null]
	});
}
function isLocalBrowserRuntime() {
	if (typeof window === "undefined") return false;
	const hostname = window.location.hostname.toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function LocalWebsiteBlockingCard({ WebsiteBlockerSettingsCard }) {
	const { handleOpenSettings, handleRequest, loading, permissions, platform } = useDesktopPermissionsState();
	if (loading) return (0, import_jsx_runtime.jsx)("p", {
		className: "py-4 text-center text-xs text-muted",
		children: "Loading website blocking..."
	});
	if (!permissions) return (0, import_jsx_runtime.jsx)(WebsiteBlockerSettingsCard, { mode: "web" });
	return (0, import_jsx_runtime.jsx)(WebsiteBlockerSettingsCard, {
		mode: "desktop",
		permission: permissions["website-blocking"],
		platform,
		onRequestPermission: () => handleRequest("website-blocking"),
		onOpenPermissionSettings: () => handleOpenSettings("website-blocking")
	});
}
function DesktopPermissionsView() {
	const { t, plugins, handlePluginToggle } = useApp();
	const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } = useBootConfig();
	const { handleOpenSettings, handleRefresh, handleRequest, handleToggleShell, loading, permissions, platform, refreshing, shellEnabled } = useDesktopPermissionsState();
	const arePermissionsGranted = useCallback((requiredPerms) => {
		if (!permissions) return false;
		return requiredPerms.every((id) => {
			const state = permissions[id];
			return state?.status === "granted" || state?.status === "not-applicable";
		});
	}, [permissions]);
	const applicablePermissions = useMemo(() => SYSTEM_PERMISSIONS.filter((def) => {
		if (!permissions) return true;
		return permissions[def.id]?.status !== "not-applicable";
	}), [permissions]);
	if (loading) return (0, import_jsx_runtime.jsx)("p", {
		className: "py-6 text-center text-xs text-muted",
		children: t("permissionssection.LoadingPermissions", { defaultValue: "Loading permissions..." })
	});
	if (!permissions) return (0, import_jsx_runtime.jsx)("p", {
		className: "py-6 text-center text-xs text-muted",
		children: t("permissionssection.UnableToLoadPermi", { defaultValue: "Unable to load permissions." })
	});
	const copy = platformCopy(platform);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-6",
		children: [
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2",
				children: [
					(0, import_jsx_runtime.jsxs)("header", {
						className: "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-0.5",
							children: [(0, import_jsx_runtime.jsx)("h3", {
								className: "text-sm font-semibold text-txt",
								children: t("permissionssection.SystemPermissions", { defaultValue: "System Permissions" })
							}), (0, import_jsx_runtime.jsx)("p", {
								className: "max-w-2xl text-xs-tight leading-5 text-muted",
								children: t(copy.systemDescription.key, { defaultValue: copy.systemDescription.defaultValue })
							})]
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap gap-2",
							children: [(0, import_jsx_runtime.jsx)(Button, {
								variant: "default",
								size: "sm",
								className: "h-9 rounded-lg px-3 text-xs font-semibold",
								onClick: async () => {
									for (const def of applicablePermissions) {
										if (def.id === "shell") continue;
										const state = permissions[def.id];
										if (state?.status === "granted") continue;
										if (state?.canRequest) await handleRequest(def.id);
										else await handleOpenSettings(def.id);
									}
								},
								children: t("permissionssection.AllowAll", { defaultValue: "Allow All" })
							}), (0, import_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								"data-testid": "permissions-refresh-button",
								className: "h-9 rounded-lg px-3 text-xs font-semibold",
								onClick: handleRefresh,
								disabled: refreshing,
								children: refreshing ? t("common.refreshing", { defaultValue: "Refreshing..." }) : t("common.refresh", { defaultValue: "Refresh" })
							})]
						})]
					}),
					(0, import_jsx_runtime.jsx)("div", {
						className: "divide-y divide-border/40 rounded-lg border border-border/40",
						children: applicablePermissions.map((def) => {
							const state = permissions[def.id];
							return (0, import_jsx_runtime.jsx)(PermissionRow, {
								def,
								status: state?.status ?? "not-determined",
								reason: state?.reason,
								platform,
								canRequest: state?.canRequest ?? false,
								onRequest: () => handleRequest(def.id),
								onOpenSettings: () => handleOpenSettings(def.id),
								isShell: def.id === "shell",
								shellEnabled,
								onToggleShell: def.id === "shell" ? handleToggleShell : void 0
							}, def.id);
						})
					}),
					(0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight leading-5 text-muted",
						children: t(copy.grantNote.key, { defaultValue: copy.grantNote.defaultValue })
					})
				]
			}),
			WebsiteBlockerSettingsCard ? (0, import_jsx_runtime.jsx)(WebsiteBlockerSettingsCard, {
				mode: "desktop",
				permission: permissions["website-blocking"],
				platform,
				onRequestPermission: () => handleRequest("website-blocking"),
				onOpenPermissionSettings: () => handleOpenSettings("website-blocking")
			}) : null,
			(0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-2 border-t border-border/40 pt-5",
				children: [(0, import_jsx_runtime.jsxs)("header", {
					className: "space-y-0.5",
					children: [(0, import_jsx_runtime.jsx)("h3", {
						className: "text-sm font-semibold text-txt",
						children: t("common.capabilities")
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "max-w-2xl text-xs-tight leading-5 text-muted",
						children: t("permissionssection.CapabilitiesDescription", { defaultValue: "Turn higher-level capabilities on only after the required runtime permissions are available." })
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "space-y-2",
					children: CAPABILITIES.map((cap) => {
						const plugin = plugins.find((p) => p.id === cap.id) ?? null;
						return (0, import_jsx_runtime.jsx)(CapabilityToggle, {
							cap,
							plugin,
							permissionsGranted: arePermissionsGranted(cap.requiredPermissions),
							onToggle: (enabled) => {
								if (plugin) handlePluginToggle(cap.id, enabled);
							}
						}, cap.id);
					})
				})]
			})
		]
	});
}
function PermissionsSection() {
	if (isWebPlatform()) return (0, import_jsx_runtime.jsx)(WebPermissionsView, {});
	if (isNative && !isDesktopPlatform()) return (0, import_jsx_runtime.jsx)(MobilePermissionsView, {});
	return (0, import_jsx_runtime.jsx)(DesktopPermissionsView, {});
}
function MobileOnboardingPermissions({ onContinue, onBack }) {
	const { t } = useApp();
	return (0, import_jsx_runtime.jsx)(StreamingPermissionsOnboardingView, {
		mode: "mobile",
		onContinue,
		onBack,
		testId: "mobile-onboarding-permissions",
		title: t("permissionssection.StreamingPermissions", { defaultValue: "Streaming Permissions" }),
		description: t("permissionssection.MobileOnboardingDesc", { defaultValue: "Allow access so your device can stream to your cloud agent." })
	});
}
function WebOnboardingPermissions({ onContinue, onBack }) {
	const { t } = useApp();
	return (0, import_jsx_runtime.jsx)(StreamingPermissionsOnboardingView, {
		mode: "web",
		onContinue,
		onBack,
		testId: "web-onboarding-permissions",
		title: t("permissionssection.BrowserPermissions", { defaultValue: "Browser Permissions" }),
		description: t("permissionssection.WebOnboardingDesc", { defaultValue: "Allow browser access so your camera, mic, and screen can stream to your agent." })
	});
}
function PermissionsOnboardingSection({ onContinue, onBack }) {
	if (isWebPlatform()) return (0, import_jsx_runtime.jsx)(WebOnboardingPermissions, {
		onContinue,
		onBack
	});
	if (isNative && !isDesktopPlatform()) return (0, import_jsx_runtime.jsx)(MobileOnboardingPermissions, {
		onContinue,
		onBack
	});
	return (0, import_jsx_runtime.jsx)(DesktopOnboardingPermissions, {
		onContinue,
		onBack
	});
}
function DesktopOnboardingPermissions({ onContinue, onBack }) {
	const { t } = useApp();
	const { handleOpenSettings, handleRequest, handleRefresh, loading, permissions, platform } = useDesktopPermissionsState();
	const [grantingPermissions, setGrantingPermissions] = useState(false);
	const usesWindowsPrivacyFlow = platform === "win32";
	const copy = platformCopy(platform);
	const canProceed = hasRequiredOnboardingPermissions(permissions) || usesWindowsPrivacyFlow;
	const essentialPermissions = SYSTEM_PERMISSIONS.filter((def) => {
		return (permissions?.[def.id])?.status !== "not-applicable" && def.id !== "shell";
	});
	const footerStatusMessage = canProceed ? t(copy.permissionReady.key, { defaultValue: copy.permissionReady.defaultValue }) : t("permissionssection.PermissionSkipNote", { defaultValue: "Skipping keeps desktop features locked until you grant the missing permissions in Settings." });
	const handleGrantPermissions = useCallback(async () => {
		if (grantingPermissions) return;
		setGrantingPermissions(true);
		try {
			for (const def of essentialPermissions) {
				const state = permissions?.[def.id];
				if (state?.status === "granted") continue;
				if (state?.status === "not-determined" && state.canRequest) {
					await handleRequest(def.id);
					continue;
				}
				await handleOpenSettings(def.id);
			}
			const refreshed = await handleRefresh();
			if (refreshed && (usesWindowsPrivacyFlow || hasRequiredOnboardingPermissions(refreshed.permissions))) onContinue();
		} finally {
			setGrantingPermissions(false);
		}
	}, [
		grantingPermissions,
		essentialPermissions,
		handleOpenSettings,
		handleRefresh,
		handleRequest,
		onContinue,
		permissions,
		usesWindowsPrivacyFlow
	]);
	if (loading) return (0, import_jsx_runtime.jsx)("p", {
		className: "py-8 text-center text-sm text-muted",
		children: t("permissionssection.CheckingPermissions", { defaultValue: "Checking permissions..." })
	});
	if (!permissions) return (0, import_jsx_runtime.jsxs)("div", {
		className: "py-8 text-center",
		children: [(0, import_jsx_runtime.jsx)("p", {
			className: "mb-4 text-sm text-muted",
			children: t("permissionssection.UnableToCheckPerm", { defaultValue: "Unable to check permissions." })
		}), (0, import_jsx_runtime.jsx)(Button, {
			type: "button",
			variant: "default",
			"data-testid": "permissions-onboarding-continue",
			onClick: () => onContinue(),
			children: t("common.continue", { defaultValue: "Continue" })
		})]
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-5",
		children: [
			(0, import_jsx_runtime.jsxs)("header", {
				className: "text-center",
				children: [(0, import_jsx_runtime.jsx)("h2", {
					className: "mb-1 text-xl font-bold text-txt",
					children: t("permissionssection.SystemPermissions", { defaultValue: "System Permissions" })
				}), (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted",
					children: t(copy.onboardingIntro.key, { defaultValue: copy.onboardingIntro.defaultValue })
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "space-y-2",
				children: essentialPermissions.map((def) => {
					const state = permissions[def.id];
					const status = state?.status ?? "not-determined";
					const isGranted = status === "granted";
					const action = getPermissionAction(t, def.id, status, state?.canRequest ?? false, platform);
					return (0, import_jsx_runtime.jsxs)("div", {
						"data-permission-id": def.id,
						className: `flex items-center gap-3 rounded-lg border px-3 py-2.5 ${isGranted ? "border-ok/30 bg-ok/5" : "border-border/50 bg-card/60"}`,
						children: [
							(0, import_jsx_runtime.jsx)(PermissionIcon, { icon: def.icon }),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-sm font-semibold text-txt",
									children: def.name
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "text-xs-tight leading-5 text-muted",
									children: def.description
								})]
							}),
							isGranted ? (0, import_jsx_runtime.jsx)(Check, { className: "h-4 w-4 shrink-0 text-ok" }) : action ? (0, import_jsx_runtime.jsx)(Button, {
								variant: "default",
								size: "sm",
								className: "h-9 rounded-lg px-3 text-xs font-semibold",
								onClick: () => action.type === "request" ? handleRequest(def.id) : handleOpenSettings(def.id),
								"aria-label": `${action.ariaLabelPrefix} ${def.name}`,
								children: action.label
							}) : null
						]
					}, def.id);
				})
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-3 border-t border-border/40 pt-4",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1 text-xs-tight leading-5 text-muted",
					children: [(0, import_jsx_runtime.jsx)("p", { children: footerStatusMessage }), !canProceed && (0, import_jsx_runtime.jsx)("p", { children: t(copy.grantSubNote.key, { defaultValue: copy.grantSubNote.defaultValue }) })]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
					children: [onBack ? (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "justify-start p-0 text-2xs uppercase tracking-[0.15em] text-muted hover:text-txt",
						onClick: () => onBack(),
						type: "button",
						children: t("onboarding.back", { defaultValue: "Back" })
					}) : (0, import_jsx_runtime.jsx)("span", {}), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end",
						children: [!canProceed && (0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "outline",
							size: "sm",
							className: "h-10 rounded-lg px-4 text-xs font-semibold",
							disabled: grantingPermissions,
							onClick: () => onContinue({ allowPermissionBypass: true }),
							children: t("onboarding.rpcSkip", { defaultValue: "Skip for now" })
						}), (0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "default",
							size: "sm",
							"data-testid": "permissions-onboarding-continue",
							className: "h-10 min-w-[8.5rem] rounded-lg px-4 text-xs font-semibold",
							disabled: grantingPermissions,
							onClick: canProceed ? () => onContinue() : handleGrantPermissions,
							children: canProceed ? t("common.continue", { defaultValue: "Continue" }) : grantingPermissions ? t("permissionssection.GrantingPermissions", { defaultValue: "Granting..." }) : t("permissionssection.GrantPermissions", { defaultValue: "Grant Permissions" })
						})]
					})]
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useAccounts.js
/**
* useAccounts — fetches and mutates the multi-account credential pool
* surfaced by `/api/accounts/*`.
*
* Polls `client.listAccounts()` on a configurable interval (default 30s)
* to keep usage / health rows fresh. Each mutation routes through the
* matching client method, applies an optimistic local update where safe,
* and reconciles after the server response. Failures bubble through
* `setActionNotice` so the parent settings panel can surface them.
*/
const DEFAULT_POLL_MS = 3e4;
function describeError(prefix, err) {
	return err instanceof Error && err.message.trim() ? `${prefix}: ${err.message}` : prefix;
}
function replaceAccount(list, providerId, next) {
	if (!list) return list;
	return { providers: list.providers.map((p) => {
		if (p.providerId !== providerId) return p;
		const existing = p.accounts.find((a) => a.id === next.id);
		const merged = existing ? {
			...existing,
			...next
		} : {
			...next,
			hasCredential: true
		};
		return {
			...p,
			accounts: p.accounts.map((a) => a.id === next.id ? merged : a).sort((a, b) => a.priority - b.priority)
		};
	}) };
}
function useAccounts(opts = {}) {
	const { setActionNotice, pollMs = DEFAULT_POLL_MS } = opts;
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(() => /* @__PURE__ */ new Set());
	const mountedRef = useRef(true);
	const notify = useCallback((prefix, err) => {
		setActionNotice?.(describeError(prefix, err), "error", 6e3);
	}, [setActionNotice]);
	const refresh = useCallback(async () => {
		try {
			const next = await client.listAccounts();
			if (!mountedRef.current) return;
			setData(next);
		} catch (err) {
			if (!mountedRef.current) return;
			notify("Failed to load accounts", err);
		} finally {
			if (mountedRef.current) setLoading(false);
		}
	}, [notify]);
	const markSaving = useCallback((id, on) => {
		setSaving((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);
	const createApiKey = useCallback(async (providerId, body) => {
		const key = `create:${providerId}`;
		markSaving(key, true);
		try {
			const created = await client.createApiKeyAccount(providerId, body);
			setData((prev) => {
				if (!prev) return prev;
				return { providers: prev.providers.map((p) => {
					if (p.providerId !== providerId) return p;
					const accounts = [...p.accounts, {
						...created,
						hasCredential: true
					}].sort((a, b) => a.priority - b.priority);
					return {
						...p,
						accounts
					};
				}) };
			});
			await refresh();
		} catch (err) {
			notify("Failed to create account", err);
			throw err;
		} finally {
			markSaving(key, false);
		}
	}, [
		markSaving,
		notify,
		refresh
	]);
	const patch = useCallback(async (providerId, accountId, body) => {
		markSaving(accountId, true);
		const previous = data;
		setData((prev) => {
			if (!prev) return prev;
			return { providers: prev.providers.map((p) => {
				if (p.providerId !== providerId) return p;
				return {
					...p,
					accounts: p.accounts.map((a) => a.id === accountId ? {
						...a,
						...body
					} : a).sort((x, y) => x.priority - y.priority)
				};
			}) };
		});
		try {
			const updated = await client.patchAccount(providerId, accountId, body);
			setData((prev) => replaceAccount(prev, providerId, updated));
		} catch (err) {
			setData(previous);
			notify("Failed to update account", err);
			throw err;
		} finally {
			markSaving(accountId, false);
		}
	}, [
		data,
		markSaving,
		notify
	]);
	const remove = useCallback(async (providerId, accountId) => {
		markSaving(accountId, true);
		try {
			await client.deleteAccount(providerId, accountId);
			setData((prev) => {
				if (!prev) return prev;
				return { providers: prev.providers.map((p) => p.providerId === providerId ? {
					...p,
					accounts: p.accounts.filter((a) => a.id !== accountId)
				} : p) };
			});
		} catch (err) {
			notify("Failed to delete account", err);
			throw err;
		} finally {
			markSaving(accountId, false);
		}
	}, [markSaving, notify]);
	const test = useCallback(async (providerId, accountId) => {
		markSaving(`test:${accountId}`, true);
		try {
			const result = await client.testAccount(providerId, accountId);
			if (result.ok) setActionNotice?.(`Connection OK${typeof result.latencyMs === "number" ? ` (${result.latencyMs}ms)` : ""}`, "success", 3e3);
			else setActionNotice?.(`Connection failed: ${result.error ?? `HTTP ${result.status ?? "?"}`}`, "error", 6e3);
			return result;
		} catch (err) {
			notify("Failed to test account", err);
			throw err;
		} finally {
			markSaving(`test:${accountId}`, false);
		}
	}, [
		markSaving,
		notify,
		setActionNotice
	]);
	const refreshUsage = useCallback(async (providerId, accountId) => {
		markSaving(`usage:${accountId}`, true);
		try {
			const result = await client.refreshAccountUsage(providerId, accountId);
			setData((prev) => replaceAccount(prev, providerId, result.account));
		} catch (err) {
			notify("Failed to refresh usage", err);
			throw err;
		} finally {
			markSaving(`usage:${accountId}`, false);
		}
	}, [markSaving, notify]);
	const setStrategy = useCallback(async (providerId, strategy) => {
		const key = `strategy:${providerId}`;
		markSaving(key, true);
		const previous = data;
		setData((prev) => {
			if (!prev) return prev;
			return { providers: prev.providers.map((p) => p.providerId === providerId ? {
				...p,
				strategy
			} : p) };
		});
		try {
			await client.patchProviderStrategy(providerId, { strategy });
		} catch (err) {
			setData(previous);
			notify("Failed to update rotation strategy", err);
			throw err;
		} finally {
			markSaving(key, false);
		}
	}, [
		data,
		markSaving,
		notify
	]);
	useEffect(() => {
		mountedRef.current = true;
		refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);
	useEffect(() => {
		if (pollMs <= 0) return;
		const id = setInterval(() => {
			refresh();
		}, pollMs);
		return () => clearInterval(id);
	}, [pollMs, refresh]);
	return {
		data,
		loading,
		saving,
		refresh,
		createApiKey,
		patch,
		remove,
		test,
		refreshUsage,
		setStrategy
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/accounts/AccountCard.js
/**
* AccountCard — single account row inside an AccountList.
*
* Renders the credential's health glyph, label (inline-editable), source
* badge, priority controls (up/down arrows — no drag-drop dependency),
* usage bars (Anthropic shows session + weekly, Codex shows session
* only), enabled toggle, Test/Refresh/Delete actions, and a confirm
* dialog for delete.
*/
function formatRelativeTime$1(epochMs) {
	if (!epochMs) return "—";
	const diff = Date.now() - epochMs;
	if (diff < 6e4) return "just now";
	if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
	if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
	return `${Math.floor(diff / 864e5)}d ago`;
}
function formatResetIn(epochMs) {
	if (!epochMs) return null;
	const diff = epochMs - Date.now();
	if (diff <= 0) return null;
	if (diff < 36e5) return `${Math.max(1, Math.floor(diff / 6e4))}m`;
	if (diff < 864e5) return `${Math.floor(diff / 36e5)}h`;
	return `${Math.floor(diff / 864e5)}d`;
}
function clampPct(value) {
	if (value == null || Number.isNaN(value)) return void 0;
	return Math.max(0, Math.min(100, value));
}
function UsageBar({ label, pct, resetsAt }) {
	const clamped = clampPct(pct);
	const resetIn = formatResetIn(resetsAt);
	const tone = clamped == null ? "bg-muted/30" : clamped >= 85 ? "bg-destructive" : clamped >= 60 ? "bg-warn" : "bg-ok";
	const titleParts = [`${label}: ${clamped == null ? "—" : `${Math.round(clamped)}%`}`];
	if (resetIn) titleParts.push(`resets in ${resetIn}`);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex min-w-0 items-center gap-1.5",
		title: titleParts.join(" · "),
		children: [
			(0, import_jsx_runtime.jsx)("span", {
				className: "w-9 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted",
				children: label
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "relative h-1.5 min-w-[48px] flex-1 overflow-hidden rounded-full bg-bg-accent",
				children: (0, import_jsx_runtime.jsx)("div", {
					className: cn("h-full transition-all", tone),
					style: { width: `${clamped ?? 0}%` }
				})
			}),
			(0, import_jsx_runtime.jsx)("span", {
				className: "w-8 shrink-0 text-right text-[10px] tabular-nums text-muted",
				children: clamped == null ? "—" : `${Math.round(clamped)}%`
			})
		]
	});
}
function deriveHealthLabel(account, t) {
	switch (account.health) {
		case "ok": return {
			label: t("accounts.health.ok", { defaultValue: "Healthy" }),
			tone: "success"
		};
		case "rate-limited": {
			const resetIn = formatResetIn(account.healthDetail?.until);
			return {
				label: resetIn ? t("accounts.health.rateLimitedWithReset", {
					defaultValue: `Rate-limited (resets in ${resetIn})`,
					resetIn
				}) : t("accounts.health.rateLimited", { defaultValue: "Rate-limited" }),
				tone: "warning"
			};
		}
		case "needs-reauth": return {
			label: t("accounts.health.needsReauth", { defaultValue: "Needs reauth" }),
			tone: "danger"
		};
		case "invalid": return {
			label: t("accounts.health.invalid", { defaultValue: "Invalid credential" }),
			tone: "danger"
		};
		default: return {
			label: t("accounts.health.unknown", { defaultValue: "Unknown" }),
			tone: "muted"
		};
	}
}
function AccountCard({ account, isFirst, isLast, saving, onPatch, onMoveUp, onMoveDown, onTest, onRefreshUsage, onDelete, testBusy = false, refreshBusy = false }) {
	const { t } = useApp();
	const [labelEditing, setLabelEditing] = useState(false);
	const [labelDraft, setLabelDraft] = useState(account.label);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleteBusy, setDeleteBusy] = useState(false);
	useEffect(() => {
		if (!labelEditing) setLabelDraft(account.label);
	}, [account.label, labelEditing]);
	const submitLabel = useCallback(async (event) => {
		event?.preventDefault();
		const trimmed = labelDraft.trim();
		setLabelEditing(false);
		if (!trimmed || trimmed === account.label) {
			setLabelDraft(account.label);
			return;
		}
		try {
			await onPatch({ label: trimmed });
		} catch {
			setLabelDraft(account.label);
		}
	}, [
		account.label,
		labelDraft,
		onPatch
	]);
	const handleLabelKey = (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setLabelDraft(account.label);
			setLabelEditing(false);
		} else if (event.key === "Enter") {
			event.preventDefault();
			submitLabel();
		}
	};
	const handleConfirmDelete = useCallback(async () => {
		setDeleteBusy(true);
		try {
			await onDelete();
			setConfirmingDelete(false);
		} finally {
			setDeleteBusy(false);
		}
	}, [onDelete]);
	const health = deriveHealthLabel(account, t);
	const isAnthropic = account.providerId === "anthropic-subscription";
	const isCodex = account.providerId === "openai-codex";
	const usage = account.usage;
	const lastUsed = formatRelativeTime$1(account.lastUsedAt);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: cn("flex flex-col gap-2 rounded-lg border border-border/45 bg-card/35 px-3 py-2.5 transition-opacity", !account.enabled && "opacity-60"),
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-x-3 gap-y-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex min-w-0 flex-1 items-center gap-2",
					children: [
						(0, import_jsx_runtime.jsx)(StatusBadge, {
							label: health.label,
							tone: health.tone,
							withDot: true
						}),
						labelEditing ? (0, import_jsx_runtime.jsx)("form", {
							onSubmit: submitLabel,
							className: "min-w-0 flex-1",
							children: (0, import_jsx_runtime.jsx)(Input, {
								value: labelDraft,
								onChange: (e) => setLabelDraft(e.target.value),
								onBlur: () => void submitLabel(),
								onKeyDown: handleLabelKey,
								autoFocus: true,
								className: "h-7 max-w-[240px] text-sm",
								"aria-label": t("accounts.label.edit", { defaultValue: "Account label" })
							})
						}) : (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setLabelEditing(true),
							title: t("accounts.label.editTooltip", { defaultValue: "Click to rename" }),
							className: "inline-flex min-w-0 items-center gap-1 truncate rounded text-sm font-medium text-txt hover:text-accent",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "truncate",
								children: account.label
							}), (0, import_jsx_runtime.jsx)(Pencil, {
								className: "h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100",
								"aria-hidden": true
							})]
						}),
						(0, import_jsx_runtime.jsx)(Badge, {
							variant: "outline",
							className: "shrink-0 text-[10px] uppercase",
							children: account.source === "oauth" ? t("accounts.source.oauth", { defaultValue: "OAuth" }) : t("accounts.source.apiKey", { defaultValue: "API key" })
						}),
						(0, import_jsx_runtime.jsxs)("span", {
							className: "shrink-0 text-[10px] tabular-nums text-muted",
							title: t("accounts.priority.tooltip", { defaultValue: "Lower priority value runs first" }),
							children: ["#", account.priority]
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 text-[10px] text-muted",
							children: t("accounts.lastUsed", {
								defaultValue: `Last used ${lastUsed}`,
								lastUsed
							})
						})
					]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex shrink-0 items-center gap-1.5",
					children: [
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							disabled: isFirst || saving,
							onClick: () => void onMoveUp(),
							"aria-label": t("accounts.moveUp", { defaultValue: "Move up" }),
							title: t("accounts.moveUp", { defaultValue: "Move up" }),
							className: "h-7 w-7 p-0",
							children: (0, import_jsx_runtime.jsx)(ChevronUp, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							disabled: isLast || saving,
							onClick: () => void onMoveDown(),
							"aria-label": t("accounts.moveDown", { defaultValue: "Move down" }),
							title: t("accounts.moveDown", { defaultValue: "Move down" }),
							className: "h-7 w-7 p-0",
							children: (0, import_jsx_runtime.jsx)(ChevronDown, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "ml-1 inline-flex items-center gap-1.5 text-xs text-muted",
							children: [(0, import_jsx_runtime.jsx)(Checkbox, {
								checked: account.enabled,
								disabled: saving,
								onCheckedChange: (value) => {
									onPatch({ enabled: value === true });
								},
								"aria-label": t("accounts.enabledToggle", { defaultValue: "Account enabled" })
							}), t("accounts.enabled", { defaultValue: "Enabled" })]
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "outline",
							size: "sm",
							disabled: testBusy || saving,
							onClick: () => void onTest(),
							className: "h-7 px-2 text-xs",
							children: testBusy ? (0, import_jsx_runtime.jsx)(Spinner, { className: "h-3 w-3" }) : t("accounts.test", { defaultValue: "Test" })
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "outline",
							size: "sm",
							disabled: refreshBusy || saving,
							onClick: () => void onRefreshUsage(),
							className: "h-7 px-2 text-xs",
							children: refreshBusy ? (0, import_jsx_runtime.jsx)(Spinner, { className: "h-3 w-3" }) : t("accounts.refresh", { defaultValue: "Refresh" })
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							disabled: saving,
							onClick: () => setConfirmingDelete(true),
							"aria-label": t("accounts.delete", { defaultValue: "Delete account" }),
							title: t("accounts.delete", { defaultValue: "Delete account" }),
							className: "h-7 w-7 p-0 text-destructive hover:bg-destructive/10",
							children: (0, import_jsx_runtime.jsx)(Trash2, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						})
					]
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-x-4 gap-y-1.5",
				children: [isAnthropic ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(UsageBar, {
					label: t("accounts.usage.session5h", { defaultValue: "5h" }),
					pct: usage?.sessionPct,
					resetsAt: usage?.resetsAt
				}), (0, import_jsx_runtime.jsx)(UsageBar, {
					label: t("accounts.usage.weekly", { defaultValue: "7d" }),
					pct: usage?.weeklyPct,
					resetsAt: usage?.resetsAt
				})] }) : isCodex ? (0, import_jsx_runtime.jsx)(UsageBar, {
					label: t("accounts.usage.session", { defaultValue: "Session" }),
					pct: usage?.sessionPct,
					resetsAt: usage?.resetsAt
				}) : usage ? (0, import_jsx_runtime.jsx)(UsageBar, {
					label: t("accounts.usage.session", { defaultValue: "Session" }),
					pct: usage.sessionPct,
					resetsAt: usage.resetsAt
				}) : (0, import_jsx_runtime.jsx)("span", {
					className: "text-xs text-muted",
					children: t("accounts.usage.none", { defaultValue: "No usage data yet — click Refresh to probe." })
				}), !account.hasCredential ? (0, import_jsx_runtime.jsx)("span", {
					className: "text-[10px] text-warn",
					title: t("accounts.orphan.tooltip", { defaultValue: "Pool metadata exists but no on-disk credential was found." }),
					children: t("accounts.orphan.label", { defaultValue: "Orphan metadata" })
				}) : null]
			}),
			(0, import_jsx_runtime.jsx)(Dialog, {
				open: confirmingDelete,
				onOpenChange: (open) => {
					if (!deleteBusy) setConfirmingDelete(open);
				},
				children: (0, import_jsx_runtime.jsxs)(DialogContent, { children: [(0, import_jsx_runtime.jsxs)(DialogHeader, { children: [(0, import_jsx_runtime.jsx)(DialogTitle, { children: t("accounts.deleteConfirm.title", { defaultValue: "Remove this account?" }) }), (0, import_jsx_runtime.jsx)(DialogDescription, { children: t("accounts.deleteConfirm.description", { defaultValue: "Removing the account deletes its stored credential and pool metadata. This cannot be undone." }) })] }), (0, import_jsx_runtime.jsxs)(DialogFooter, {
					className: "gap-2",
					children: [(0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						variant: "ghost",
						disabled: deleteBusy,
						onClick: () => setConfirmingDelete(false),
						children: t("accounts.cancel", { defaultValue: "Cancel" })
					}), (0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						variant: "destructive",
						disabled: deleteBusy,
						onClick: () => void handleConfirmDelete(),
						children: deleteBusy ? (0, import_jsx_runtime.jsx)(Spinner, { className: "h-3 w-3" }) : t("accounts.delete.confirm", { defaultValue: "Remove account" })
					})]
				})] })
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/accounts/AddAccountDialog.js
const SUBSCRIPTION_PROVIDERS$1 = new Set(["anthropic-subscription", "openai-codex"]);
function isSubscriptionProvider(providerId) {
	return SUBSCRIPTION_PROVIDERS$1.has(providerId);
}
function providerDisplayName(providerId, t) {
	switch (providerId) {
		case "anthropic-subscription": return t("accounts.provider.anthropicSubscription", { defaultValue: "Anthropic Claude subscription" });
		case "openai-codex": return t("accounts.provider.openaiCodex", { defaultValue: "OpenAI Codex subscription" });
		case "anthropic-api": return t("accounts.provider.anthropicApi", { defaultValue: "Anthropic API" });
		case "openai-api": return t("accounts.provider.openaiApi", { defaultValue: "OpenAI API" });
		default: return providerId;
	}
}
function AddAccountDialog({ open, providerId, onClose, onCreated }) {
	const { t } = useApp();
	const subscriptionProvider = isSubscriptionProvider(providerId);
	const [step, setStep] = useState(subscriptionProvider ? "choose" : "apikey");
	const [label, setLabel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [oauthCode, setOauthCode] = useState("");
	const [errorMessage, setErrorMessage] = useState(null);
	const [sessionId, setSessionId] = useState(null);
	const eventSourceRef = useRef(null);
	const sessionIdRef = useRef(null);
	const openRef = useRef(open);
	useEffect(() => {
		openRef.current = open;
	}, [open]);
	const closeEventSource = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
	}, []);
	const cancelInflightFlow = useCallback(async () => {
		closeEventSource();
		const id = sessionIdRef.current;
		if (id) {
			sessionIdRef.current = null;
			try {
				await client.cancelAccountOAuth(providerId, { sessionId: id });
			} catch {}
		}
	}, [closeEventSource, providerId]);
	const reset = useCallback(() => {
		closeEventSource();
		sessionIdRef.current = null;
		setStep(subscriptionProvider ? "choose" : "apikey");
		setLabel("");
		setApiKey("");
		setOauthCode("");
		setErrorMessage(null);
		setSessionId(null);
	}, [closeEventSource, subscriptionProvider]);
	useEffect(() => {
		if (!open) {
			cancelInflightFlow();
			reset();
		}
	}, [
		open,
		cancelInflightFlow,
		reset
	]);
	useEffect(() => {
		return () => {
			closeEventSource();
		};
	}, [closeEventSource]);
	const subscribeToFlow = useCallback((newSessionId) => {
		closeEventSource();
		const url = `/api/accounts/${providerId}/oauth/status?sessionId=${encodeURIComponent(newSessionId)}`;
		const source = new EventSource(url);
		eventSourceRef.current = source;
		let connectedOnce = false;
		let persistentErrorTimer = null;
		const cancelPersistentErrorTimer = () => {
			if (persistentErrorTimer) {
				clearTimeout(persistentErrorTimer);
				persistentErrorTimer = null;
			}
		};
		source.onopen = () => {
			connectedOnce = true;
			cancelPersistentErrorTimer();
		};
		source.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.status === "success" && data.account) {
					cancelPersistentErrorTimer();
					closeEventSource();
					sessionIdRef.current = null;
					onCreated(data.account);
					onClose();
				} else if (data.status === "error" || data.status === "cancelled" || data.status === "timeout") {
					cancelPersistentErrorTimer();
					closeEventSource();
					sessionIdRef.current = null;
					setErrorMessage(data.error ?? t(`accounts.add.oauth.${data.status}`, { defaultValue: data.status === "timeout" ? "Login timed out. Try again." : data.status === "cancelled" ? "Login cancelled." : "Login failed." }));
					setStep("error");
				}
			} catch {}
		};
		source.onerror = () => {
			if (persistentErrorTimer) return;
			persistentErrorTimer = setTimeout(() => {
				persistentErrorTimer = null;
				if (!connectedOnce && eventSourceRef.current?.readyState === EventSource.CLOSED) {
					closeEventSource();
					sessionIdRef.current = null;
					setErrorMessage(t("accounts.add.oauth.sseUnreachable", { defaultValue: "Lost connection to the OAuth status stream. Try again." }));
					setStep("error");
				}
			}, 5e3);
		};
	}, [
		closeEventSource,
		onClose,
		onCreated,
		providerId,
		t
	]);
	const startOAuth = useCallback(async () => {
		setErrorMessage(null);
		setStep("oauth-starting");
		const win = preOpenWindow();
		try {
			const flow = await client.startAccountOAuth(providerId, { label: label.trim() });
			if (!openRef.current) {
				try {
					await client.cancelAccountOAuth(providerId, { sessionId: flow.sessionId });
				} catch {}
				try {
					win?.close();
				} catch {}
				return;
			}
			navigatePreOpenedWindow(win, flow.authUrl);
			sessionIdRef.current = flow.sessionId;
			setSessionId(flow.sessionId);
			if (flow.needsCodeSubmission) setStep("oauth-need-code");
			else setStep("oauth-waiting");
			subscribeToFlow(flow.sessionId);
		} catch (err) {
			setErrorMessage(err instanceof Error && err.message ? err.message : t("accounts.add.oauth.startFailed", { defaultValue: "Failed to start login flow." }));
			setStep("error");
			try {
				win?.close();
			} catch {}
		}
	}, [
		label,
		providerId,
		subscribeToFlow,
		t
	]);
	const submitOAuthCode = useCallback(async (event) => {
		event.preventDefault();
		const code = oauthCode.trim();
		const id = sessionIdRef.current;
		if (!code || !id) return;
		try {
			await client.submitAccountOAuthCode(providerId, {
				sessionId: id,
				code
			});
			setOauthCode("");
			setStep("oauth-waiting");
		} catch (err) {
			setErrorMessage(err instanceof Error && err.message ? err.message : t("accounts.add.oauth.codeFailed", { defaultValue: "Failed to submit code." }));
			setStep("error");
		}
	}, [
		oauthCode,
		providerId,
		t
	]);
	const submitApiKey = useCallback(async (event) => {
		event.preventDefault();
		const trimmedLabel = label.trim();
		const trimmedKey = apiKey.trim();
		if (!trimmedLabel || !trimmedKey) return;
		setErrorMessage(null);
		setStep("apikey-submitting");
		try {
			onCreated(await client.createApiKeyAccount(providerId, {
				label: trimmedLabel,
				apiKey: trimmedKey
			}));
			onClose();
		} catch (err) {
			setErrorMessage(err instanceof Error && err.message ? err.message : t("accounts.add.apikey.failed", { defaultValue: "Failed to add account." }));
			setStep("error");
		}
	}, [
		apiKey,
		label,
		onClose,
		onCreated,
		providerId,
		t
	]);
	const handleClose = useCallback(() => {
		cancelInflightFlow();
		onClose();
	}, [cancelInflightFlow, onClose]);
	const labelInput = (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-1.5",
		children: [(0, import_jsx_runtime.jsx)(Label, {
			htmlFor: "add-account-label",
			children: t("accounts.add.label", { defaultValue: "Account name" })
		}), (0, import_jsx_runtime.jsx)(Input, {
			id: "add-account-label",
			value: label,
			onChange: (e) => setLabel(e.target.value),
			placeholder: t("accounts.add.labelPlaceholder", { defaultValue: "e.g. Personal, Work" }),
			maxLength: 120,
			autoFocus: true
		})]
	});
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open,
		onOpenChange: (next) => {
			if (!next) handleClose();
		},
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			className: "max-w-md",
			children: [
				(0, import_jsx_runtime.jsxs)(DialogHeader, { children: [(0, import_jsx_runtime.jsx)(DialogTitle, { children: t("accounts.add.title", {
					defaultValue: `Add ${providerDisplayName(providerId, t)} account`,
					provider: providerDisplayName(providerId, t)
				}) }), (0, import_jsx_runtime.jsx)(DialogDescription, { children: subscriptionProvider ? t("accounts.add.subscriptionDescription", { defaultValue: "Sign in with your provider to add another account to the rotation pool." }) : t("accounts.add.apiDescription", { defaultValue: "Paste your API key. The key is stored locally with mode 0600." }) })] }),
				step === "choose" ? (0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-3 py-2",
					children: [labelInput, (0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						variant: "default",
						disabled: !label.trim(),
						onClick: () => void startOAuth(),
						className: "h-10",
						children: t("accounts.add.signIn", {
							defaultValue: `Sign in with ${providerDisplayName(providerId, t)}`,
							provider: providerDisplayName(providerId, t)
						})
					})]
				}) : null,
				step === "oauth-starting" ? (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-3 py-6 text-sm text-muted",
					children: [(0, import_jsx_runtime.jsx)(Spinner, { className: "h-4 w-4" }), t("accounts.add.oauth.starting", { defaultValue: "Starting login flow…" })]
				}) : null,
				step === "oauth-waiting" ? (0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-3 py-3 text-sm text-muted",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-3",
						children: [(0, import_jsx_runtime.jsx)(Spinner, { className: "h-4 w-4" }), (0, import_jsx_runtime.jsx)("span", { children: t("accounts.add.oauth.waiting", { defaultValue: "Waiting for browser… Complete the sign-in there." }) })]
					}), sessionId ? (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs text-muted",
						children: t("accounts.add.oauth.sessionHint", {
							defaultValue: "Session: {{sessionId}}",
							sessionId: `${sessionId.slice(0, 8)}…`
						})
					}) : null]
				}) : null,
				step === "oauth-need-code" ? (0, import_jsx_runtime.jsxs)("form", {
					onSubmit: submitOAuthCode,
					className: "grid gap-3 py-2",
					children: [
						(0, import_jsx_runtime.jsx)("p", {
							className: "text-xs text-muted",
							children: t("accounts.add.oauth.codeHint", { defaultValue: "Auto-redirect didn't reach us. Paste the code (or full redirect URL) from the browser." })
						}),
						(0, import_jsx_runtime.jsx)(Input, {
							value: oauthCode,
							onChange: (e) => setOauthCode(e.target.value),
							placeholder: t("accounts.add.oauth.codePlaceholder", { defaultValue: "Paste the code or redirect URL" }),
							autoFocus: true
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							variant: "default",
							disabled: !oauthCode.trim(),
							className: "h-9",
							children: t("accounts.add.oauth.submitCode", { defaultValue: "Submit code" })
						})
					]
				}) : null,
				step === "apikey" || step === "apikey-submitting" ? (0, import_jsx_runtime.jsxs)("form", {
					onSubmit: submitApiKey,
					className: "grid gap-3 py-2",
					children: [
						labelInput,
						(0, import_jsx_runtime.jsxs)("div", {
							className: "grid gap-1.5",
							children: [(0, import_jsx_runtime.jsx)(Label, {
								htmlFor: "add-account-apikey",
								children: t("accounts.add.apiKey", { defaultValue: "API key" })
							}), (0, import_jsx_runtime.jsx)(Input, {
								id: "add-account-apikey",
								type: "password",
								value: apiKey,
								onChange: (e) => setApiKey(e.target.value),
								placeholder: "sk-…",
								autoComplete: "off",
								spellCheck: false
							})]
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							variant: "default",
							disabled: step === "apikey-submitting" || !label.trim() || !apiKey.trim(),
							className: "h-9",
							children: step === "apikey-submitting" ? (0, import_jsx_runtime.jsx)(Spinner, { className: "h-3 w-3" }) : t("accounts.add.save", { defaultValue: "Add account" })
						})
					]
				}) : null,
				step === "error" && errorMessage ? (0, import_jsx_runtime.jsx)("div", {
					className: cn("rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"),
					role: "alert",
					children: errorMessage
				}) : null,
				(0, import_jsx_runtime.jsxs)(DialogFooter, {
					className: "gap-2",
					children: [step === "error" ? (0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						variant: "ghost",
						onClick: () => {
							setErrorMessage(null);
							setStep(subscriptionProvider ? "choose" : "apikey");
						},
						children: t("accounts.add.tryAgain", { defaultValue: "Try again" })
					}) : null, (0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						variant: "ghost",
						onClick: handleClose,
						children: t("accounts.cancel", { defaultValue: "Cancel" })
					})]
				})
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/accounts/RotationStrategyPicker.js
const STRATEGY_OPTIONS = [
	{
		id: "priority",
		labelKey: "accounts.strategy.priority.label",
		labelFallback: "Priority",
		descriptionKey: "accounts.strategy.priority.description",
		descriptionFallback: "Always prefer the top healthy account."
	},
	{
		id: "round-robin",
		labelKey: "accounts.strategy.roundRobin.label",
		labelFallback: "Round-robin",
		descriptionKey: "accounts.strategy.roundRobin.description",
		descriptionFallback: "Alternate across enabled accounts."
	},
	{
		id: "least-used",
		labelKey: "accounts.strategy.leastUsed.label",
		labelFallback: "Least used",
		descriptionKey: "accounts.strategy.leastUsed.description",
		descriptionFallback: "Prefer the account with the lowest current usage."
	},
	{
		id: "quota-aware",
		labelKey: "accounts.strategy.quotaAware.label",
		labelFallback: "Quota-aware",
		descriptionKey: "accounts.strategy.quotaAware.description",
		descriptionFallback: "Skip accounts above 85% utilization."
	}
];
function RotationStrategyPicker({ providerId, value, onChange, disabled }) {
	const { t } = useApp();
	const resolved = value ?? "priority";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "text-[10px] font-medium uppercase tracking-wider text-muted",
			children: t("accounts.strategy.label", { defaultValue: "Strategy" })
		}), (0, import_jsx_runtime.jsxs)(Select, {
			value: resolved,
			onValueChange: (next) => {
				if (next !== resolved) onChange(next);
			},
			disabled,
			children: [(0, import_jsx_runtime.jsx)(SelectTrigger, {
				id: `rotation-strategy-${providerId}`,
				className: "h-8 w-[160px] rounded-lg border border-border bg-card text-xs",
				children: (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: t("accounts.strategy.choose", { defaultValue: "Choose strategy" }) })
			}), (0, import_jsx_runtime.jsx)(SelectContent, { children: STRATEGY_OPTIONS.map((option) => (0, import_jsx_runtime.jsx)(SelectItem, {
				value: option.id,
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-0.5 py-0.5",
					children: [(0, import_jsx_runtime.jsx)("span", {
						className: "text-sm font-medium text-txt",
						children: t(option.labelKey, { defaultValue: option.labelFallback })
					}), (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs text-muted",
						children: t(option.descriptionKey, { defaultValue: option.descriptionFallback })
					})]
				})
			}, option.id)) })]
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/accounts/AccountList.js
const SUBSCRIPTION_PROVIDERS = new Set(["anthropic-subscription", "openai-codex"]);
function AccountList({ providerId }) {
	const { t } = useApp();
	const accounts = useAccounts();
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const providerEntry = useMemo(() => accounts.data?.providers.find((p) => p.providerId === providerId), [accounts.data, providerId]);
	const sorted = useMemo(() => providerEntry ? [...providerEntry.accounts].sort((a, b) => a.priority - b.priority) : [], [providerEntry]);
	const addDisabled = !SUBSCRIPTION_PROVIDERS.has(providerId);
	const handleMove = useCallback(async (accountId, direction) => {
		const index = sorted.findIndex((a) => a.id === accountId);
		if (index < 0) return;
		const neighbourIndex = direction === "up" ? index - 1 : index + 1;
		if (neighbourIndex < 0 || neighbourIndex >= sorted.length) return;
		const self = sorted[index];
		const neighbour = sorted[neighbourIndex];
		if (!self || !neighbour || self.priority === neighbour.priority) return;
		const selfOriginal = self.priority;
		const neighbourOriginal = neighbour.priority;
		await accounts.patch(providerId, self.id, { priority: neighbourOriginal });
		try {
			await accounts.patch(providerId, neighbour.id, { priority: selfOriginal });
		} catch (err) {
			try {
				await accounts.patch(providerId, self.id, { priority: selfOriginal });
			} catch {
				accounts.refresh();
			}
			throw err;
		}
	}, [
		accounts,
		providerId,
		sorted
	]);
	if (accounts.loading && !accounts.data) return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 flex items-center gap-2 text-xs text-muted",
		children: [(0, import_jsx_runtime.jsx)(Spinner, { className: "h-3 w-3" }), t("accounts.loading", { defaultValue: "Loading accounts…" })]
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 flex flex-col gap-2 rounded-xl border border-border/40 bg-bg-accent/40 p-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "flex items-center gap-2",
					children: (0, import_jsx_runtime.jsx)("h3", {
						className: "text-xs font-semibold uppercase tracking-wider text-muted",
						children: t("accounts.heading", {
							defaultValue: "Accounts ({{count}})",
							count: sorted.length
						})
					})
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(RotationStrategyPicker, {
						providerId,
						value: providerEntry?.strategy,
						onChange: (strategy) => {
							accounts.setStrategy(providerId, strategy);
						},
						disabled: accounts.saving.has(`strategy:${providerId}`)
					}), (0, import_jsx_runtime.jsxs)(Button, {
						type: "button",
						variant: "default",
						size: "sm",
						disabled: addDisabled,
						onClick: () => setAddDialogOpen(true),
						title: addDisabled ? t("accounts.add.disabledHint", { defaultValue: "API-key accounts for this provider are not yet supported." }) : void 0,
						className: "h-8 gap-1 px-2.5 text-xs",
						children: [(0, import_jsx_runtime.jsx)(Plus, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}), t("accounts.add.button", { defaultValue: "Add account" })]
					})]
				})]
			}),
			sorted.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted",
				children: t("accounts.empty", { defaultValue: "No accounts yet — add one to start using this provider." })
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-col gap-2",
				children: sorted.map((account, index) => (0, import_jsx_runtime.jsx)(AccountCard, {
					account,
					isFirst: index === 0,
					isLast: index === sorted.length - 1,
					saving: accounts.saving.has(account.id),
					testBusy: accounts.saving.has(`test:${account.id}`),
					refreshBusy: accounts.saving.has(`usage:${account.id}`),
					onPatch: (body) => accounts.patch(providerId, account.id, body),
					onMoveUp: () => handleMove(account.id, "up"),
					onMoveDown: () => handleMove(account.id, "down"),
					onTest: async () => {
						await accounts.test(providerId, account.id);
					},
					onRefreshUsage: () => accounts.refreshUsage(providerId, account.id),
					onDelete: () => accounts.remove(providerId, account.id)
				}, account.id))
			}),
			(0, import_jsx_runtime.jsx)(AddAccountDialog, {
				open: addDialogOpen,
				providerId,
				onClose: () => setAddDialogOpen(false),
				onCreated: () => {
					accounts.refresh();
				}
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/settings-control-primitives.js
function SettingsField({ className, ...props }) {
	return (0, import_jsx_runtime.jsx)(Field, {
		className: cn("gap-1.5", className),
		...props
	});
}
function SettingsFieldLabel({ className, ...props }) {
	return (0, import_jsx_runtime.jsx)(FieldLabel, {
		className: cn("text-xs font-semibold text-txt", className),
		...props
	});
}
function AdvancedSettingsDisclosure({ title = "Advanced", children, className }) {
	return (0, import_jsx_runtime.jsxs)("details", {
		className: cn("group rounded-xl border border-border/60 bg-card/45 px-3 py-2", className),
		children: [(0, import_jsx_runtime.jsx)("summary", {
			className: "cursor-pointer select-none list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-txt",
			children: title
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "mt-3 border-t border-border/40 pt-3",
			children
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/ActiveModelBar.js
function ActiveModelBar({ active, installed, onUnload, busy }) {
	if (!active.modelId) return null;
	const label = installed.find((m) => m.id === active.modelId)?.displayName ?? active.modelId;
	const status = active.status === "loading" ? "loading" : active.status === "ready" ? "ready" : `error: ${active.error ?? "unknown"}`;
	const dotClass = active.status === "error" ? "bg-danger" : active.status === "loading" ? "bg-warn" : "bg-ok";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs",
		title: `${label} · ${status}`,
		children: [
			(0, import_jsx_runtime.jsx)("span", {
				className: `inline-flex h-2 w-2 rounded-full ${dotClass}`,
				"aria-hidden": true
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1 truncate",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "font-medium",
					children: label
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "ml-1.5 text-muted",
					children: status
				})]
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				size: "sm",
				variant: "outline",
				className: "h-7 rounded-md px-2 text-xs",
				onClick: onUnload,
				disabled: busy,
				children: "Unload"
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/DeviceBridgeStatus.js
function DeviceBridgeStatusBar() {
	const [status, setStatus] = useState(null);
	useEffect(() => {
		const raw = resolveApiUrl("/api/local-inference/device/stream");
		const token = getElizaApiToken()?.trim();
		const url = token ? `${raw}${raw.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : raw;
		const es = new EventSource(url);
		es.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data);
				if (payload.type === "status") setStatus(payload.status);
			} catch {}
		};
		return () => es.close();
	}, []);
	if (!status) return null;
	const dotClass = status.connected ? "bg-emerald-500" : status.pendingRequests > 0 ? "bg-amber-500" : "bg-muted-foreground/40";
	const label = status.connected ? `Paired device online${status.capabilities ? ` · ${status.capabilities.platform} · ${status.capabilities.deviceModel}` : ""}` : status.pendingRequests > 0 ? `Device offline · ${status.pendingRequests} request${status.pendingRequests === 1 ? "" : "s"} paused pending reconnect` : "No paired device";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2 py-1.5 text-xs",
		title: label,
		children: [
			(0, import_jsx_runtime.jsx)("span", {
				className: `inline-flex h-2 w-2 rounded-full ${dotClass}`,
				"aria-hidden": true
			}),
			(0, import_jsx_runtime.jsx)("span", {
				className: "flex-1 truncate",
				children: label
			}),
			status.loadedPath && (0, import_jsx_runtime.jsx)("span", {
				className: "max-w-[40%] truncate text-muted",
				children: status.loadedPath.split(/[/\\]/).pop()
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/DevicesPanel.js
/**
* Multi-device panel. Lists every connected bridge device (desktop +
* phone + tablet, etc.) ranked by score. The device ranked first is the
* "primary" — new generate calls route there by default. Devices that
* drop offline show up greyed-out until they reconnect.
*/
function DevicesPanel() {
	const [status, setStatus] = useState(null);
	useEffect(() => {
		const raw = resolveApiUrl("/api/local-inference/device/stream");
		const token = getElizaApiToken()?.trim();
		const url = token ? `${raw}${raw.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : raw;
		const es = new EventSource(url);
		es.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data);
				if (payload.type === "status") setStatus(payload.status);
			} catch {}
		};
		return () => es.close();
	}, []);
	if (!status || status.devices.length === 0) return null;
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "flex flex-col gap-2",
		children: [
			(0, import_jsx_runtime.jsx)("h3", {
				className: "text-sm font-semibold uppercase tracking-wide text-muted-foreground",
				children: "Connected bridge devices"
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted-foreground",
				children: "Requests route to the highest-scoring device available. Scoring favours desktops over phones, more RAM, and an available GPU. The primary device is the one ranked first."
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-col gap-2",
				children: status.devices.map((device) => (0, import_jsx_runtime.jsxs)("div", {
					className: `rounded-xl border p-3 flex items-center gap-3 text-sm ${device.isPrimary ? "border-primary/50 bg-primary/5" : "border-border bg-card"}`,
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: `inline-flex h-2 w-2 rounded-full ${device.isPrimary ? "bg-emerald-500" : "bg-muted-foreground/60"}`,
							"aria-hidden": true
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex-1 min-w-0",
							children: [(0, import_jsx_runtime.jsxs)("div", {
								className: "font-medium truncate",
								children: [device.capabilities.deviceModel, device.isPrimary && (0, import_jsx_runtime.jsx)("span", {
									className: "ml-2 text-[10px] uppercase tracking-wide text-primary",
									children: "primary"
								})]
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "text-xs text-muted-foreground truncate",
								children: [
									device.capabilities.platform,
									" ·",
									" ",
									device.capabilities.totalRamGb.toFixed(0),
									" GB RAM ·",
									" ",
									device.capabilities.gpu?.available ? `${device.capabilities.gpu.backend}${device.capabilities.gpu.totalVramGb ? ` ${device.capabilities.gpu.totalVramGb.toFixed(1)} GB` : ""}` : "CPU only",
									device.loadedPath && ` · loaded: ${device.loadedPath.split(/[/\\]/).pop()}`
								]
							})]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "text-xs text-muted-foreground",
							children: [
								"score ",
								Math.round(device.score),
								device.activeRequests > 0 && ` · ${device.activeRequests} active`
							]
						})
					]
				}, device.deviceId))
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/local-inference/hardware.js
const BYTES_PER_GB = 1024 ** 3;
/**
* Compatibility assessment for a specific model given current hardware.
*
* Green/fits: comfortable headroom (model < 70% of effective memory).
* Yellow/tight: will run but may swap or stutter under load.
* Red/wontfit: exceeds available memory.
*/
function assessFit(probe, modelSizeGb, minRamGb) {
	const effectiveGb = probe.appleSilicon ? probe.totalRamGb : probe.gpu ? Math.max(probe.gpu.totalVramGb, probe.totalRamGb * .5) : probe.totalRamGb * .5;
	if (effectiveGb < minRamGb) return "wontfit";
	if (modelSizeGb > effectiveGb * .9) return "wontfit";
	if (modelSizeGb > effectiveGb * .7) return "tight";
	return "fits";
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/hub-utils.js
/**
* Pure helpers used by the Model Hub UI. Kept separate from components so
* they can be covered by unit tests without a DOM.
*/
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "—";
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
function formatEta(ms) {
	if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
	const totalSec = Math.ceil(ms / 1e3);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function progressPercent(job) {
	if (!job || job.total <= 0) return 0;
	return Math.min(100, Math.round(job.received / job.total * 100));
}
const BUCKET_LABEL = {
	small: "Fast",
	mid: "Balanced",
	large: "High quality",
	xl: "Premium"
};
function bucketLabel(bucket) {
	return BUCKET_LABEL[bucket];
}
function fitLabel(fit) {
	if (fit === "fits") return "Runs smoothly";
	if (fit === "tight") return "Slow on your device";
	return "Not enough memory";
}
function computeFit(model, hardware) {
	return assessFit(hardware, model.sizeGb, model.minRamGb);
}
/**
* Decide whether a catalog model is already installed.
* External models show up with ids like `external-<origin>-<hash>` so we
* also tolerate matches by filename basename.
*/
function findInstalled(model, installed) {
	const byId = installed.find((m) => m.id === model.id);
	if (byId) return byId;
	const target = model.ggufFile.toLowerCase();
	return installed.find((m) => m.path.toLowerCase().endsWith(`/${target}`) || m.path.toLowerCase().endsWith(`\\${target}`));
}
function findDownload(modelId, downloads) {
	return downloads.find((d) => d.modelId === modelId);
}
/**
* Client-side lookup of a catalog entry by id. Accepts the catalog as an
* argument so the hub UI can mix curated + HF-search results without
* importing the server-side singleton.
*/
function findCatalogModel(id, catalog) {
	return catalog.find((m) => m.id === id);
}
function groupByBucket(models) {
	const groups = /* @__PURE__ */ new Map();
	for (const bucket of [
		"small",
		"mid",
		"large",
		"xl"
	]) groups.set(bucket, []);
	for (const model of models) groups.get(model.bucket)?.push(model);
	return groups;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/DownloadProgress.js
function DownloadProgress({ job }) {
	const pct = progressPercent(job);
	const eta = formatEta(job.etaMs);
	const speed = job.bytesPerSec > 0 ? `${formatBytes(job.bytesPerSec)}/s` : "";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "w-full",
		children: [(0, import_jsx_runtime.jsx)("div", {
			className: "h-2 w-full overflow-hidden rounded bg-muted",
			role: "progressbar",
			"aria-valuenow": pct,
			"aria-valuemin": 0,
			"aria-valuemax": 100,
			children: (0, import_jsx_runtime.jsx)("div", {
				className: "h-full bg-primary transition-[width] duration-300",
				style: { width: `${pct}%` }
			})
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-1 flex justify-between text-xs text-muted-foreground",
			children: [(0, import_jsx_runtime.jsxs)("span", { children: [
				formatBytes(job.received),
				" of ",
				formatBytes(job.total),
				" · ",
				pct,
				"%"
			] }), (0, import_jsx_runtime.jsxs)("span", { children: [speed, eta ? ` · ${eta} left` : ""] })]
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/DownloadQueue.js
/**
* Global view of all in-flight downloads. The SSE stream already removes
* completed + cancelled jobs from the snapshot, so this list only holds
* active/queued/failed jobs. Failures stick around until a new download
* for the same model supersedes them.
*/
function DownloadQueue({ downloads, catalog, onCancel }) {
	if (downloads.length === 0) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground",
		children: "No downloads in progress. Start one from the Curated or HuggingFace search tab."
	});
	return (0, import_jsx_runtime.jsx)("ul", {
		className: "flex flex-col gap-3",
		children: downloads.map((job) => {
			const label = findCatalogModel(job.modelId, catalog)?.displayName ?? job.modelId;
			const isActive = job.state === "downloading" || job.state === "queued";
			return (0, import_jsx_runtime.jsxs)("li", {
				className: "rounded-xl border border-border bg-card p-4 flex flex-col gap-3",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-start justify-between gap-3",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "min-w-0",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "font-medium truncate",
								children: label
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "text-xs text-muted-foreground",
								children: [
									job.state === "queued" && "Queued",
									job.state === "downloading" && "Downloading",
									job.state === "failed" && "Failed",
									job.state === "completed" && "Completed",
									job.state === "cancelled" && "Cancelled"
								]
							})]
						}), isActive && (0, import_jsx_runtime.jsx)(Button, {
							size: "sm",
							variant: "outline",
							onClick: () => onCancel(job.modelId),
							children: "Cancel"
						})]
					}),
					(job.state === "downloading" || job.state === "queued") && (0, import_jsx_runtime.jsx)(DownloadProgress, { job }),
					job.state === "failed" && job.error && (0, import_jsx_runtime.jsx)("div", {
						className: "text-xs text-rose-500",
						children: job.error
					})
				]
			}, job.jobId);
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/FirstRunOffer.js
const DISMISS_STORAGE_KEY = "eliza.localInference.firstRunOfferDismissed";
function FirstRunOffer({ catalog, installed, hardware, onDownload, busy }) {
	const [dismissed, setDismissed] = useState(() => typeof window !== "undefined" && window.localStorage?.getItem(DISMISS_STORAGE_KEY) === "1");
	if (installed.filter((m) => m.source === "eliza-download").length > 0 || dismissed) return null;
	const recommended = pickRecommended(catalog, installed, hardware);
	if (!recommended) return null;
	const handleDismiss = () => {
		setDismissed(true);
		try {
			window.localStorage?.setItem(DISMISS_STORAGE_KEY, "1");
		} catch {}
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-wrap items-center gap-2 rounded-lg border border-primary/45 bg-primary/10 px-2.5 py-2",
		title: recommended.blurb,
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1",
			children: [
				(0, import_jsx_runtime.jsx)("span", {
					className: "rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase leading-none text-primary",
					children: "Recommended"
				}),
				(0, import_jsx_runtime.jsx)("span", {
					className: "truncate text-sm font-medium",
					children: recommended.displayName
				}),
				(0, import_jsx_runtime.jsxs)("span", {
					className: "text-muted text-xs",
					children: [
						recommended.params,
						" · ",
						recommended.sizeGb.toFixed(1),
						" GB"
					]
				})
			]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex gap-1.5",
			children: [(0, import_jsx_runtime.jsxs)(Button, {
				size: "sm",
				className: "h-7 rounded-md px-2 text-xs",
				onClick: () => onDownload(recommended.id),
				disabled: busy,
				children: ["Download ", recommended.params]
			}), (0, import_jsx_runtime.jsx)(Button, {
				size: "sm",
				variant: "ghost",
				className: "h-7 rounded-md px-2 text-xs",
				onClick: handleDismiss,
				children: "Not now"
			})]
		})]
	});
}
function pickRecommended(catalog, installed, hardware) {
	const bucket = hardware.recommendedBucket;
	const notInstalled = catalog.filter((m) => m.bucket === bucket).filter((m) => !findInstalled(m, installed));
	const chatFirst = [...notInstalled.filter((m) => m.category === "chat"), ...notInstalled.filter((m) => m.category !== "chat")];
	if (chatFirst[0]) return chatFirst[0];
	for (const alt of ["mid", "small"]) {
		if (alt === bucket) continue;
		const candidate = catalog.find((m) => m.bucket === alt && !findInstalled(m, installed) && m.category === "chat");
		if (candidate) return candidate;
	}
	return null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/HardwareBadge.js
function HardwareBadge({ hardware }) {
	const gpuText = hardware.gpu ? `${hardware.gpu.backend.toUpperCase()} · ${hardware.gpu.totalVramGb.toFixed(1)} GB VRAM` : "CPU only";
	const chipLabel = hardware.appleSilicon ? "Apple Silicon" : hardware.arch;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1.5 text-xs",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1",
				title: "CPU and memory",
				children: [(0, import_jsx_runtime.jsx)(Cpu, {
					className: "h-3.5 w-3.5 shrink-0 text-muted",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsxs)("span", {
					className: "truncate font-medium",
					children: [
						hardware.totalRamGb.toFixed(0),
						" GB · ",
						hardware.cpuCores,
						"c ·",
						" ",
						chipLabel
					]
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1",
				title: "GPU",
				children: [(0, import_jsx_runtime.jsx)(HardDrive, {
					className: "h-3.5 w-3.5 shrink-0 text-muted",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "truncate font-medium",
					children: gpuText
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1",
				title: "Recommended preset",
				children: [(0, import_jsx_runtime.jsx)(Gauge, {
					className: "h-3.5 w-3.5 shrink-0 text-muted",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "font-medium",
					children: bucketLabel(hardware.recommendedBucket)
				})]
			}),
			hardware.source === "os-fallback" && (0, import_jsx_runtime.jsxs)("div", {
				className: "inline-flex items-center gap-1.5 rounded-md bg-warn/10 px-2 py-1 text-warn",
				title: "Install plugin-local-ai for full GPU detection",
				children: [(0, import_jsx_runtime.jsx)(AlertTriangle, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("span", { children: "GPU probe limited" })]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/ModelCard.js
const FIT_STYLES$1 = {
	fits: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10",
	tight: "text-amber-500 border-amber-500/40 bg-amber-500/10",
	wontfit: "text-rose-500 border-rose-500/40 bg-rose-500/10"
};
function ModelCard({ model, hardware, installed, downloads, active, onDownload, onCancel, onActivate, onUninstall, onVerify, onRedownload, busy }) {
	const fit = computeFit(model, hardware);
	const installedEntry = findInstalled(model, installed);
	const download = findDownload(model.id, downloads);
	const downloading = download?.state === "downloading" || download?.state === "queued";
	const failed = download?.state === "failed";
	const isActive = active.modelId === model.id && active.status !== "error";
	const activating = active.modelId === model.id && active.status === "loading";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-xl border border-border bg-card p-4 flex flex-col gap-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start justify-between gap-3",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "font-semibold truncate",
						children: model.displayName
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "text-xs text-muted-foreground truncate",
						children: [
							model.params,
							" · ",
							model.quant,
							" · ",
							model.sizeGb.toFixed(1),
							" GB"
						]
					})]
				}), (0, import_jsx_runtime.jsx)("span", {
					className: `shrink-0 rounded-full border px-2 py-0.5 text-xs ${FIT_STYLES$1[fit]}`,
					children: fitLabel(fit)
				})]
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-sm text-muted-foreground line-clamp-2",
				children: model.blurb
			}),
			installedEntry && (0, import_jsx_runtime.jsxs)("div", {
				className: "text-xs text-muted-foreground",
				children: [
					"Installed · ",
					formatBytes(installedEntry.sizeBytes),
					installedEntry.source === "external-scan" && installedEntry.externalOrigin && ` · via ${installedEntry.externalOrigin}`
				]
			}),
			download && downloading && (0, import_jsx_runtime.jsx)(DownloadProgress, { job: download }),
			failed && download?.error && (0, import_jsx_runtime.jsxs)("div", {
				className: "text-xs text-rose-500",
				children: ["Download failed: ", download.error]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap gap-2",
				children: [
					!installedEntry && !downloading && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						onClick: () => onDownload(model.id),
						disabled: busy || fit === "wontfit",
						children: "Download"
					}),
					downloading && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => onCancel(model.id),
						disabled: busy,
						children: "Cancel"
					}),
					installedEntry && !isActive && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						onClick: () => onActivate(model.id),
						disabled: busy || activating,
						children: activating ? "Activating…" : "Make active"
					}),
					isActive && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "outline",
						disabled: true,
						children: "Active"
					}),
					installedEntry && onVerify && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => onVerify(installedEntry.id),
						disabled: busy,
						children: "Verify"
					}),
					installedEntry?.source === "eliza-download" && onRedownload && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => onRedownload(model.id),
						disabled: busy,
						children: "Redownload"
					}),
					installedEntry?.source === "eliza-download" && (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => onUninstall(model.id),
						disabled: busy,
						children: "Uninstall"
					})
				]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/HuggingFaceSearch.js
/**
* Secondary tab of the Model Hub: free-form HuggingFace search for any
* GGUF-tagged repo. Results are shaped like CatalogModel so they render
* with the same ModelCard the curated view uses.
*
* Debounced so a user typing a query doesn't hammer the HF API.
*/
function HuggingFaceSearch({ installed, downloads, active, hardware, onDownload, onCancel, onActivate, onUninstall, busy }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);
	const lastQueryRef = useRef("");
	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			setResults([]);
			setError(null);
			lastQueryRef.current = "";
			return;
		}
		const handle = setTimeout(async () => {
			lastQueryRef.current = trimmed;
			setLoading(true);
			setError(null);
			try {
				const response = await client.searchHuggingFaceGguf(trimmed);
				if (lastQueryRef.current === trimmed) setResults(response.models);
			} catch (err) {
				if (lastQueryRef.current === trimmed) {
					setError(err instanceof Error ? err.message : "Search failed");
					setResults([]);
				}
			} finally {
				if (lastQueryRef.current === trimmed) setLoading(false);
			}
		}, 400);
		return () => clearTimeout(handle);
	}, [query]);
	const handleDownloadClick = useCallback((_modelId) => {
		const spec = results.find((r) => r.id === _modelId);
		if (spec) onDownload(spec);
	}, [onDownload, results]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)("input", {
					type: "search",
					value: query,
					onChange: (e) => setQuery(e.target.value),
					placeholder: "Search HuggingFace (e.g. phi-3, mixtral, llama 3.3)",
					className: "flex-1 rounded-md border border-border bg-bg/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
				}), query.trim().length > 0 && (0, import_jsx_runtime.jsx)(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => {
						setQuery("");
						setResults([]);
					},
					children: "Clear"
				})]
			}),
			loading && (0, import_jsx_runtime.jsx)("div", {
				className: "text-sm text-muted-foreground",
				children: "Searching HuggingFace…"
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-500",
				children: error
			}),
			!loading && !error && query.trim().length >= 2 && results.length === 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "text-sm text-muted-foreground",
				children: "No GGUF repos matched. Try a different keyword."
			}),
			results.length > 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3",
				children: results.map((model) => (0, import_jsx_runtime.jsx)(ModelCard, {
					model,
					hardware,
					installed,
					downloads,
					active,
					onDownload: handleDownloadClick,
					onCancel,
					onActivate,
					onUninstall,
					busy
				}, model.id))
			}),
			(0, import_jsx_runtime.jsxs)("p", {
				className: "text-xs text-muted-foreground",
				children: [
					"Results are live HuggingFace repos tagged ",
					(0, import_jsx_runtime.jsx)("code", { children: "gguf" }),
					", sorted by downloads. Eliza picks the best quant (preferring Q4_K_M) when a repo has several."
				]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/ModelHubView.js
const BUCKET_ORDER = [
	"small",
	"mid",
	"large",
	"xl"
];
const FIT_STYLES = {
	fits: "text-ok",
	tight: "text-warn",
	wontfit: "text-danger"
};
function ModelHubView({ catalog, installed, downloads, active, hardware, onDownload, onCancel, onActivate, onUninstall, onVerify, onRedownload, busy }) {
	const grouped = useMemo(() => groupByBucket(catalog), [catalog]);
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex flex-col gap-4",
		children: BUCKET_ORDER.map((bucket) => {
			const models = grouped.get(bucket) ?? [];
			if (models.length === 0) return null;
			const isRecommended = hardware.recommendedBucket === bucket;
			return (0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-2",
				children: [(0, import_jsx_runtime.jsxs)("header", {
					className: "flex h-6 items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)("h3", {
						className: "text-[10px] font-semibold uppercase tracking-wider text-muted",
						children: bucketLabel(bucket)
					}), isRecommended && (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-full border border-primary/45 bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary",
						children: "Recommended"
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "overflow-hidden rounded-lg border border-border/50 bg-card/35",
					children: models.map((model) => (0, import_jsx_runtime.jsx)(ModelListRow, {
						model,
						hardware,
						installed,
						downloads,
						active,
						onDownload,
						onCancel,
						onActivate,
						onUninstall,
						onVerify,
						onRedownload,
						busy
					}, model.id))
				})]
			}, bucket);
		})
	});
}
function ModelListRow({ model, hardware, installed, downloads, active, onDownload, onCancel, onActivate, onUninstall, onVerify, onRedownload, busy }) {
	const fit = computeFit(model, hardware);
	const installedEntry = findInstalled(model, installed);
	const download = findDownload(model.id, downloads);
	const downloading = download?.state === "downloading" || download?.state === "queued";
	const failed = download?.state === "failed";
	const isActive = active.modelId === model.id && active.status !== "error";
	const activating = active.modelId === model.id && active.status === "loading";
	const modelMeta = [
		model.params,
		model.quant,
		`${model.sizeGb.toFixed(1)} GB`
	];
	return (0, import_jsx_runtime.jsx)("div", {
		className: "border-border/40 border-b px-2.5 py-2 last:border-b-0",
		title: model.blurb,
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex min-w-0 items-center gap-2",
						children: [
							isActive ? (0, import_jsx_runtime.jsx)("span", {
								className: "inline-flex h-5 w-5 shrink-0 items-center justify-center text-accent",
								title: "Active",
								role: "img",
								"aria-label": "Active model",
								children: (0, import_jsx_runtime.jsx)(CheckCircle2, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							}) : null,
							(0, import_jsx_runtime.jsx)("div", {
								className: "min-w-0 flex-1 truncate font-semibold text-sm text-txt",
								children: model.displayName
							}),
							(0, import_jsx_runtime.jsx)("span", {
								className: `inline-flex h-5 w-5 shrink-0 items-center justify-center ${FIT_STYLES[fit]}`,
								title: fitLabel(fit),
								role: "img",
								"aria-label": `Fit: ${fitLabel(fit)}`,
								children: (0, import_jsx_runtime.jsx)("span", { className: "h-2 w-2 rounded-full bg-current" })
							})
						]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted text-xs",
						children: [(0, import_jsx_runtime.jsx)("span", { children: modelMeta.join(" · ") }), installedEntry ? (0, import_jsx_runtime.jsxs)("span", { children: [
							"Installed · ",
							formatBytes(installedEntry.sizeBytes),
							installedEntry.source === "external-scan" && installedEntry.externalOrigin ? ` · via ${installedEntry.externalOrigin}` : ""
						] }) : null]
					}),
					download && downloading ? (0, import_jsx_runtime.jsx)("div", {
						className: "mt-1.5",
						children: (0, import_jsx_runtime.jsx)(DownloadProgress, { job: download })
					}) : null,
					failed && download?.error ? (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1 text-danger text-xs",
						children: ["Download failed: ", download.error]
					}) : null
				]
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-1.5 md:justify-end",
				children: [
					!installedEntry && !downloading ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onDownload(model.id),
						disabled: busy || fit === "wontfit",
						children: "Download"
					}) : null,
					downloading ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "outline",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onCancel(model.id),
						disabled: busy,
						children: "Cancel"
					}) : null,
					installedEntry && !isActive ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onActivate(model.id),
						disabled: busy || activating,
						children: activating ? "Activating..." : "Make active"
					}) : null,
					installedEntry && onVerify ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onVerify(installedEntry.id),
						disabled: busy,
						children: "Verify"
					}) : null,
					installedEntry?.source === "eliza-download" && onRedownload ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onRedownload(model.id),
						disabled: busy,
						children: "Redownload"
					}) : null,
					installedEntry?.source === "eliza-download" ? (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: "ghost",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onUninstall(model.id),
						disabled: busy,
						children: "Uninstall"
					}) : null
				]
			})]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/SlotAssignments.js
const SLOTS$1 = [
	{
		slot: "TEXT_SMALL",
		label: "Small text",
		description: "Short completions, classifications, and background requests."
	},
	{
		slot: "TEXT_LARGE",
		label: "Large text",
		description: "Main chat responses, planning, and reasoning."
	},
	{
		slot: "TEXT_EMBEDDING",
		label: "Embeddings",
		description: "Vector search and memory when a local embedding handler exists."
	},
	{
		slot: "OBJECT_SMALL",
		label: "Small structured output",
		description: "XML/JSON structured generation on the small path."
	},
	{
		slot: "OBJECT_LARGE",
		label: "Large structured output",
		description: "Structured generation on the large path."
	}
];
/**
* Per-ModelType slot assignment UI. Renders one dropdown per agent model
* slot; selecting a model writes the assignment to disk immediately.
* Slots with no assignment fall through to the legacy "active model"
* behaviour (use whatever is currently loaded).
*/
function SlotAssignments({ installed, assignments, onChange }) {
	const [busySlot, setBusySlot] = useState(null);
	const handleChange = useCallback(async (slot, modelId) => {
		setBusySlot(slot);
		try {
			onChange((await client.setLocalInferenceAssignment(slot, modelId)).assignments);
		} finally {
			setBusySlot(null);
		}
	}, [onChange]);
	if (installed.length === 0) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground",
		children: "Download or scan at least one model to use local inference."
	});
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "flex flex-col gap-3",
		children: [
			(0, import_jsx_runtime.jsx)("h3", {
				className: "text-sm font-semibold uppercase tracking-wide text-muted-foreground",
				children: "Local model assignments"
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted-foreground",
				children: "Eliza defaults both text routes to the largest installed local model so only one model has to stay in memory. Override a slot only when you explicitly want a different local model."
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "grid grid-cols-1 gap-3 md:grid-cols-2",
				children: SLOTS$1.map(({ slot, label, description }) => {
					const currentId = assignments[slot] ?? "";
					return (0, import_jsx_runtime.jsxs)("label", {
						className: "rounded-xl border border-border bg-card p-3 flex flex-col gap-1.5",
						children: [
							(0, import_jsx_runtime.jsx)("span", {
								className: "text-sm font-medium",
								children: label
							}),
							(0, import_jsx_runtime.jsx)("span", {
								className: "text-xs text-muted-foreground",
								children: description
							}),
							(0, import_jsx_runtime.jsxs)("select", {
								value: currentId,
								disabled: busySlot === slot,
								onChange: (e) => void handleChange(slot, e.target.value || null),
								className: "mt-1 rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm",
								children: [(0, import_jsx_runtime.jsx)("option", {
									value: "",
									children: "Auto"
								}), installed.map((m) => (0, import_jsx_runtime.jsxs)("option", {
									value: m.id,
									children: [m.displayName, m.source === "external-scan" ? ` · via ${m.externalOrigin}` : ""]
								}, m.id))]
							})
						]
					}, slot);
				})
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/LocalInferencePanel.js
function LocalInferencePanel() {
	const { setActionNotice } = useApp();
	const [hub, setHub] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const [tab, setTab] = useState("curated");
	const eventSourceRef = useRef(null);
	const refresh = useCallback(async () => {
		try {
			setHub(await client.getLocalInferenceHub());
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load models");
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	useEffect(() => {
		const withToken = appendTokenParam(resolveApiUrl("/api/local-inference/downloads/stream"));
		const es = new EventSource(withToken, { withCredentials: false });
		eventSourceRef.current = es;
		es.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data);
				if (payload.type === "snapshot") setHub((prev) => prev ? {
					...prev,
					downloads: payload.downloads,
					active: payload.active
				} : prev);
				else if (payload.type === "active") setHub((prev) => prev ? {
					...prev,
					active: payload.active
				} : prev);
				else {
					setHub((prev) => {
						if (!prev) return prev;
						const others = prev.downloads.filter((d) => d.modelId !== payload.job.modelId);
						const downloads = payload.type === "completed" || payload.type === "cancelled" ? others : [...others, payload.job];
						return {
							...prev,
							downloads
						};
					});
					if (payload.type === "completed") refresh();
				}
			} catch {}
		};
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) setError("Live updates disconnected");
		};
		return () => {
			es.close();
			eventSourceRef.current = null;
		};
	}, [refresh]);
	const withBusy = useCallback(async (fn) => {
		setBusy(true);
		try {
			return await fn();
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : String(err), "error", 4e3);
			return;
		} finally {
			setBusy(false);
		}
	}, [setActionNotice]);
	const handleDownload = useCallback((modelId) => {
		withBusy(async () => {
			await client.startLocalInferenceDownload(modelId);
			setActionNotice("Download started", "success", 2e3);
		});
	}, [setActionNotice, withBusy]);
	const handleDownloadSpec = useCallback((spec) => {
		withBusy(async () => {
			await client.startLocalInferenceDownload(spec);
			setActionNotice(`Downloading ${spec.displayName}`, "success", 2e3);
		});
	}, [setActionNotice, withBusy]);
	const handleCancel = useCallback((modelId) => {
		withBusy(async () => {
			await client.cancelLocalInferenceDownload(modelId);
		});
	}, [withBusy]);
	const handleActivate = useCallback((modelId) => {
		withBusy(async () => {
			const active = await client.setLocalInferenceActive(modelId);
			setHub((prev) => prev ? {
				...prev,
				active
			} : prev);
			if (active.status === "error") setActionNotice(active.error ?? "Failed to activate", "error", 4e3);
			else if (active.status === "ready") setActionNotice("Model activated", "success", 2e3);
		});
	}, [setActionNotice, withBusy]);
	const handleUnload = useCallback(() => {
		withBusy(async () => {
			const active = await client.clearLocalInferenceActive();
			setHub((prev) => prev ? {
				...prev,
				active
			} : prev);
		});
	}, [withBusy]);
	const handleUninstall = useCallback((modelId) => {
		withBusy(async () => {
			await client.uninstallLocalInferenceModel(modelId);
			setActionNotice("Model uninstalled", "success", 2e3);
			await refresh();
		});
	}, [
		refresh,
		setActionNotice,
		withBusy
	]);
	const handleVerify = useCallback((modelId) => {
		withBusy(async () => {
			const result = await client.verifyLocalInferenceModel(modelId);
			const tone = result.state === "ok" ? "success" : result.state === "unknown" ? "success" : "error";
			setActionNotice(result.state === "ok" ? "Model verified" : result.state === "unknown" ? "Baseline hash recorded — future verifies will compare against it" : result.state === "missing" ? "Model file is missing from disk" : result.state === "truncated" ? "Model file is corrupt (not a valid GGUF)" : "Model hash doesn't match the installed copy — re-download recommended", tone, 4e3);
			await refresh();
		});
	}, [
		refresh,
		setActionNotice,
		withBusy
	]);
	const handleRedownload = useCallback((modelId) => {
		withBusy(async () => {
			await client.uninstallLocalInferenceModel(modelId);
			await client.startLocalInferenceDownload(modelId);
			setActionNotice("Redownload started", "success", 2e3);
			await refresh();
		});
	}, [
		refresh,
		setActionNotice,
		withBusy
	]);
	const handleAssignmentsChange = useCallback((next) => {
		setHub((prev) => prev ? {
			...prev,
			assignments: next
		} : prev);
	}, []);
	if (error && !hub) return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
		children: [(0, import_jsx_runtime.jsx)("span", { children: error }), (0, import_jsx_runtime.jsx)(Button, {
			size: "sm",
			variant: "outline",
			className: "h-8 rounded-lg",
			onClick: refresh,
			children: "Retry"
		})]
	});
	if (!hub) return (0, import_jsx_runtime.jsx)("p", {
		className: "text-sm text-muted",
		children: "Loading local models…"
	});
	const catalog = hub.catalog;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3",
		children: [
			(0, import_jsx_runtime.jsx)(HardwareBadge, { hardware: hub.hardware }),
			(0, import_jsx_runtime.jsx)(DeviceBridgeStatusBar, {}),
			(0, import_jsx_runtime.jsx)(FirstRunOffer, {
				catalog,
				installed: hub.installed,
				hardware: hub.hardware,
				onDownload: handleDownload,
				busy
			}),
			(0, import_jsx_runtime.jsx)(ActiveModelBar, {
				active: hub.active,
				installed: hub.installed,
				onUnload: handleUnload,
				busy
			}),
			(0, import_jsx_runtime.jsx)("nav", {
				className: "inline-flex h-8 w-fit items-center rounded-lg border border-border/60 bg-bg/40 p-0.5",
				children: [
					["curated", "Curated"],
					["search", "Search"],
					["downloads", "Downloads"]
				].map(([id, label]) => {
					return (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setTab(id),
						className: `h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${tab === id ? "bg-card text-txt shadow-sm" : "text-muted hover:text-txt"}`,
						children: (0, import_jsx_runtime.jsxs)("span", {
							className: "inline-flex items-center gap-1.5",
							children: [label, id === "downloads" && hub.downloads.length > 0 ? (0, import_jsx_runtime.jsx)("span", {
								className: "rounded-full border border-border/50 bg-card px-1.5 py-0.5 text-[10px] leading-none text-muted",
								children: hub.downloads.length
							}) : null]
						})
					}, id);
				})
			}),
			tab === "curated" && (0, import_jsx_runtime.jsx)(ModelHubView, {
				catalog,
				installed: hub.installed,
				downloads: hub.downloads,
				active: hub.active,
				hardware: hub.hardware,
				onDownload: handleDownload,
				onCancel: handleCancel,
				onActivate: handleActivate,
				onUninstall: handleUninstall,
				onVerify: handleVerify,
				onRedownload: handleRedownload,
				busy
			}),
			tab === "search" && (0, import_jsx_runtime.jsx)(HuggingFaceSearch, {
				installed: hub.installed,
				downloads: hub.downloads,
				active: hub.active,
				hardware: hub.hardware,
				onDownload: handleDownloadSpec,
				onCancel: handleCancel,
				onActivate: handleActivate,
				onUninstall: handleUninstall,
				busy
			}),
			tab === "downloads" && (0, import_jsx_runtime.jsx)(DownloadQueue, {
				downloads: hub.downloads,
				catalog: hub.catalog,
				onCancel: handleCancel
			}),
			(0, import_jsx_runtime.jsx)(AdvancedSettingsDisclosure, {
				title: "Local model assignments",
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-3",
					children: [
						(0, import_jsx_runtime.jsx)(SlotAssignments, {
							installed: hub.installed,
							assignments: hub.assignments,
							onChange: handleAssignmentsChange
						}),
						(0, import_jsx_runtime.jsx)(DevicesPanel, {}),
						(0, import_jsx_runtime.jsx)(ExternalInstalledSummary, {
							installed: hub.installed,
							onActivate: handleActivate,
							active: hub.active,
							busy
						})
					]
				})
			})
		]
	});
}
function ExternalInstalledSummary({ installed, onActivate, active, busy }) {
	const external = installed.filter((m) => m.source === "external-scan");
	if (external.length === 0) return null;
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "space-y-2 border-t border-border/40 pt-3",
		children: [(0, import_jsx_runtime.jsx)("header", { children: (0, import_jsx_runtime.jsx)("h3", {
			className: "text-[10px] font-medium uppercase tracking-wider text-muted",
			title: "Eliza can load these models without re-downloading.",
			children: "Discovered from other tools"
		}) }), (0, import_jsx_runtime.jsx)("div", {
			className: "grid grid-cols-1 gap-2 md:grid-cols-2",
			children: external.map((m) => {
				const isActive = active.modelId === m.id && active.status !== "error";
				return (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/60 px-2 py-1.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "truncate text-sm font-medium text-txt",
							children: m.displayName
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "truncate text-xs-tight text-muted",
							children: [
								m.externalOrigin,
								" · ",
								formatSize(m.sizeBytes)
							]
						})]
					}), isActive ? (0, import_jsx_runtime.jsx)("span", {
						className: "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ok/35 bg-ok/10 text-ok",
						title: "Active",
						role: "img",
						"aria-label": "Active",
						children: (0, import_jsx_runtime.jsx)(CheckCircle2, {
							className: "h-4 w-4",
							"aria-hidden": true
						})
					}) : (0, import_jsx_runtime.jsxs)(Button, {
						size: "sm",
						className: "h-7 rounded-md px-2 text-xs",
						onClick: () => onActivate(m.id),
						disabled: busy,
						children: [(0, import_jsx_runtime.jsx)(Play, {
							className: "h-3.5 w-3.5",
							"aria-hidden": true
						}), "Activate"]
					})]
				}, m.id);
			})
		})]
	});
}
function formatSize(bytes) {
	const gb = bytes / 1024 ** 3;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
function appendTokenParam(url) {
	const token = getElizaApiToken()?.trim();
	if (!token) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/ProvidersList.js
const KIND_ICON = {
	"cloud-api": {
		Icon: KeyRound,
		label: "Cloud API"
	},
	"cloud-subscription": {
		Icon: Cloud,
		label: "Subscription"
	},
	local: {
		Icon: Cpu,
		label: "Local"
	},
	"device-bridge": {
		Icon: Smartphone,
		label: "Device bridge"
	}
};
function ProvidersList() {
	const [providers, setProviders] = useState(null);
	const [error, setError] = useState(null);
	const refresh = useCallback(async () => {
		try {
			const { providers: nextProviders } = await client.getLocalInferenceProviders();
			setProviders(nextProviders);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load providers");
		}
	}, []);
	useEffect(() => {
		refresh();
		const interval = setInterval(() => void refresh(), 1e4);
		return () => clearInterval(interval);
	}, [refresh]);
	if (error && !providers) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm",
		children: error
	});
	if (!providers) return (0, import_jsx_runtime.jsx)("p", {
		className: "text-sm text-muted-foreground",
		children: "Loading providers…"
	});
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "flex flex-col gap-3",
		children: [(0, import_jsx_runtime.jsx)("header", { children: (0, import_jsx_runtime.jsx)("h3", {
			className: "text-[10px] font-medium uppercase tracking-wider text-muted",
			children: "Providers"
		}) }), (0, import_jsx_runtime.jsx)("div", {
			className: "grid grid-cols-1 gap-3 md:grid-cols-2",
			children: providers.map((p) => {
				const dot = p.enableState.enabled ? "bg-emerald-500" : "bg-muted-foreground/40";
				const { Icon, label } = KIND_ICON[p.kind];
				return (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-xl border border-border bg-card p-3 flex flex-col gap-2",
					children: [
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2",
							children: [
								(0, import_jsx_runtime.jsx)("span", {
									className: `inline-flex h-2 w-2 rounded-full ${dot}`,
									"aria-hidden": true
								}),
								(0, import_jsx_runtime.jsx)(Icon, {
									className: "h-3.5 w-3.5 shrink-0 text-muted",
									"aria-hidden": true
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "font-medium truncate",
									children: p.label
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "sr-only",
									children: label
								})
							]
						}),
						(0, import_jsx_runtime.jsx)("p", {
							className: "text-xs text-muted-foreground line-clamp-2",
							children: p.description
						}),
						(0, import_jsx_runtime.jsx)("div", {
							className: "flex flex-wrap gap-1",
							children: p.supportedSlots.map((slot) => {
								const active = p.registeredSlots.includes(slot);
								return (0, import_jsx_runtime.jsx)("span", {
									className: `rounded-full border px-1.5 py-0.5 text-[10px] ${active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`,
									title: active ? "Handler currently registered" : "Supported but not currently registered",
									children: slot
								}, slot);
							})
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center justify-between gap-2 text-xs",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "text-muted-foreground truncate",
								children: p.enableState.reason
							}), p.configureHref && (0, import_jsx_runtime.jsx)("a", {
								href: p.configureHref,
								className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted transition-colors hover:bg-bg hover:text-txt",
								title: "Configure",
								"aria-label": `Configure ${p.label}`,
								children: (0, import_jsx_runtime.jsx)(Settings, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							})]
						})
					]
				}, p.id);
			})
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/local-inference/RoutingMatrix.js
const DEFAULT_POLICY = "prefer-local";
const SLOTS = [
	"TEXT_SMALL",
	"TEXT_LARGE",
	"TEXT_EMBEDDING",
	"OBJECT_SMALL",
	"OBJECT_LARGE"
];
const POLICIES = [
	{
		value: "manual",
		label: "Manual",
		hint: "Use the preferred provider below."
	},
	{
		value: "cheapest",
		label: "Cheapest",
		hint: "Lowest $/token. Local is free."
	},
	{
		value: "fastest",
		label: "Fastest",
		hint: "Lowest measured p50 latency."
	},
	{
		value: "prefer-local",
		label: "Prefer local",
		hint: "Try on-device first, fall through to cloud."
	},
	{
		value: "round-robin",
		label: "Round robin",
		hint: "Distribute load across all eligible providers."
	}
];
const SLOT_MODEL_TYPE = {
	TEXT_SMALL: "TEXT_SMALL",
	TEXT_LARGE: "TEXT_LARGE",
	TEXT_EMBEDDING: "TEXT_EMBEDDING",
	OBJECT_SMALL: "OBJECT_SMALL",
	OBJECT_LARGE: "OBJECT_LARGE"
};
const SLOT_LABEL = {
	TEXT_SMALL: "Small text",
	TEXT_LARGE: "Large text",
	TEXT_EMBEDDING: "Embeddings",
	OBJECT_SMALL: "Small structured output",
	OBJECT_LARGE: "Large structured output"
};
function RoutingMatrix() {
	const [registrations, setRegistrations] = useState([]);
	const [preferences, setPreferences] = useState({
		preferredProvider: {},
		policy: {}
	});
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(null);
	const refresh = useCallback(async () => {
		try {
			const data = await client.getLocalInferenceRouting();
			setRegistrations(data.registrations);
			setPreferences(data.preferences);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load routing");
		}
	}, []);
	useEffect(() => {
		refresh();
		const interval = setInterval(() => void refresh(), 15e3);
		return () => clearInterval(interval);
	}, [refresh]);
	const handlePolicy = useCallback(async (slot, policy) => {
		setBusy(slot);
		try {
			setPreferences((await client.setLocalInferencePolicy(slot, policy)).preferences);
		} finally {
			setBusy(null);
		}
	}, []);
	const handlePreferred = useCallback(async (slot, provider) => {
		setBusy(slot);
		try {
			setPreferences((await client.setLocalInferencePreferredProvider(slot, provider)).preferences);
		} finally {
			setBusy(null);
		}
	}, []);
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "flex flex-col gap-3",
		children: [
			(0, import_jsx_runtime.jsx)("header", { children: (0, import_jsx_runtime.jsx)("h3", {
				className: "text-[10px] font-medium uppercase tracking-wider text-muted",
				children: "Model routing"
			}) }),
			error ? (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200",
				children: error
			}) : null,
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-col gap-2",
				children: SLOTS.map((slot) => {
					const modelType = SLOT_MODEL_TYPE[slot];
					const candidates = registrations.filter((r) => r.modelType === modelType).filter((r) => r.provider !== "eliza-router").sort((a, b) => b.priority - a.priority);
					const policy = preferences.policy[slot] ?? DEFAULT_POLICY;
					const preferred = preferences.preferredProvider[slot] ?? "";
					const disabled = busy === slot;
					return (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-xl border border-border bg-card p-3 flex flex-col gap-2",
						children: [
							(0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center justify-between gap-2",
								children: [(0, import_jsx_runtime.jsx)("span", {
									className: "font-medium text-sm",
									title: slot,
									children: SLOT_LABEL[slot]
								}), (0, import_jsx_runtime.jsx)("span", {
									className: `h-2 w-2 rounded-full ${candidates.length > 0 ? "bg-ok" : "bg-muted"}`,
									title: `${candidates.length} available provider${candidates.length === 1 ? "" : "s"}`,
									"aria-hidden": true
								})]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "grid grid-cols-1 gap-2 md:grid-cols-2",
								children: [(0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-xs",
									children: [(0, import_jsx_runtime.jsx)("span", {
										className: "text-muted-foreground",
										children: "Policy"
									}), (0, import_jsx_runtime.jsx)("select", {
										value: policy,
										disabled,
										onChange: (e) => void handlePolicy(slot, e.target.value),
										className: "rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm",
										children: POLICIES.map((p) => (0, import_jsx_runtime.jsx)("option", {
											value: p.value,
											title: p.hint,
											children: p.label
										}, p.value))
									})]
								}), (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-xs",
									children: [(0, import_jsx_runtime.jsxs)("span", {
										className: "text-muted-foreground",
										children: ["Preferred provider", policy !== "manual" && " (manual only)"]
									}), (0, import_jsx_runtime.jsxs)("select", {
										value: preferred,
										disabled,
										onChange: (e) => void handlePreferred(slot, e.target.value || null),
										className: "rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm disabled:opacity-60",
										children: [(0, import_jsx_runtime.jsx)("option", {
											value: "",
											children: "Auto"
										}), candidates.map((c) => (0, import_jsx_runtime.jsxs)("option", {
											value: c.provider,
											children: [c.provider, typeof c.priority === "number" ? ` (priority ${c.priority})` : ""]
										}, c.provider))]
									})]
								})]
							}),
							candidates.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
								className: "text-xs text-muted-foreground italic",
								children: "No provider has registered a handler for this slot yet."
							}) : (0, import_jsx_runtime.jsx)("div", {
								className: "flex flex-wrap gap-1",
								children: candidates.map((c) => (0, import_jsx_runtime.jsx)("span", {
									className: "rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground",
									children: c.provider
								}, c.provider))
							})
						]
					}, slot);
				})
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/config/api-key-prefix-hints.js
/**
* Known API-key prefix patterns — used by the Settings save form to
* surface inline warnings when the user pastes something that looks
* wrong (e.g., a model slug like `tencent/hy3-preview` into the
* OPENROUTER_API_KEY field).
*
* Mirrors `KEY_PREFIX_HINTS` in
* `packages/agent/src/api/plugin-validation.ts` — the server-side
* version runs at save time and surfaces a warning in the validation
* result; the client-side version here runs as the user types so they
* catch the mistake before it lands on disk.
*
* Keep both in sync. If a third party plugin needs prefix validation,
* add it here and to plugin-validation.ts. (Future: derive from a
* shared registry; the duplication is acknowledged-but-bounded for
* now since the data is small and rarely changes.)
*/
const API_KEY_PREFIX_HINTS = {
	ANTHROPIC_API_KEY: {
		prefix: "sk-ant-",
		label: "Anthropic"
	},
	OPENAI_API_KEY: {
		prefix: "sk-",
		label: "OpenAI"
	},
	GROQ_API_KEY: {
		prefix: "gsk_",
		label: "Groq"
	},
	XAI_API_KEY: {
		prefix: "xai-",
		label: "xAI"
	},
	OPENROUTER_API_KEY: {
		prefix: "sk-or-",
		label: "OpenRouter"
	}
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/ApiKeyConfig.js
function ApiKeyConfig({ selectedProvider, pluginSaving, pluginSaveSuccess, handlePluginConfigSave, loadPlugins }) {
	const { setTimeout } = useTimeout();
	const { configRef, validateAll } = useConfigValidation();
	const { t } = useApp();
	const [pluginFieldValues, setPluginFieldValues] = useState({});
	const [modelsFetching, setModelsFetching] = useState(false);
	const [modelsFetchResult, setModelsFetchResult] = useState(null);
	const handlePluginFieldChange = useCallback((pluginId, key, value) => {
		setPluginFieldValues((prev) => ({
			...prev,
			[pluginId]: {
				...prev[pluginId] ?? {},
				[key]: value
			}
		}));
	}, []);
	const handlePluginSave = useCallback((pluginId) => {
		if (!validateAll()) return;
		handlePluginConfigSave(pluginId, pluginFieldValues[pluginId] ?? {});
	}, [
		pluginFieldValues,
		handlePluginConfigSave,
		validateAll
	]);
	const handleFetchModels = useCallback(async (providerId) => {
		setModelsFetching(true);
		setModelsFetchResult(null);
		try {
			const result = await client.fetchModels(providerId, true);
			setModelsFetchResult({
				tone: "success",
				message: t("apikeyconfig.loadedModels", { count: Array.isArray(result?.models) ? result.models.length : 0 })
			});
			await loadPlugins();
			setTimeout(() => setModelsFetchResult(null), 3e3);
		} catch (err) {
			setModelsFetchResult({
				tone: "error",
				message: t("apikeyconfig.error", { message: err instanceof Error ? err.message : t("common.failed") })
			});
			setTimeout(() => setModelsFetchResult(null), 5e3);
		}
		setModelsFetching(false);
	}, [
		loadPlugins,
		setTimeout,
		t
	]);
	if (!selectedProvider || selectedProvider.parameters.length === 0) return null;
	const isSaving = pluginSaving.has(selectedProvider.id);
	const saveSuccess = pluginSaveSuccess.has(selectedProvider.id);
	const params = selectedProvider.parameters;
	const configured = selectedProvider.configured;
	const properties = {};
	const required = [];
	const hints = {};
	const serverHints = selectedProvider.configUiHints ?? {};
	for (const p of params) {
		const prop = {};
		if (p.type === "boolean") prop.type = "boolean";
		else if (p.type === "number") prop.type = "number";
		else prop.type = "string";
		if (p.description) prop.description = p.description;
		if (p.default != null) prop.default = p.default;
		if (p.options?.length) prop.enum = p.options;
		const k = p.key.toUpperCase();
		if (k.includes("URL") || k.includes("ENDPOINT")) prop.format = "uri";
		properties[p.key] = prop;
		if (p.required) required.push(p.key);
		const prefixHint = API_KEY_PREFIX_HINTS[p.key];
		const fieldHint = {
			label: autoLabel(p.key, selectedProvider.id),
			sensitive: p.sensitive ?? false,
			...prefixHint ? {
				pattern: `^${prefixHint.prefix}`,
				patternError: `${prefixHint.label} keys start with "${prefixHint.prefix}" — this doesn't look like a valid key. (Did you paste a model name into the wrong field?)`
			} : {},
			...serverHints[p.key]
		};
		hints[p.key] = fieldHint;
		if (p.description && !hints[p.key].help) hints[p.key].help = p.description;
	}
	const schema = {
		type: "object",
		properties,
		required
	};
	const values = {};
	const setKeys = /* @__PURE__ */ new Set();
	for (const p of params) {
		const cv = pluginFieldValues[selectedProvider.id]?.[p.key];
		if (cv !== void 0) values[p.key] = cv;
		else if (p.isSet && !p.sensitive && p.currentValue != null) values[p.key] = p.currentValue;
		if (p.isSet) setKeys.add(p.key);
	}
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "border-t border-border/40 pt-4",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-3 flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-xs font-semibold text-txt",
					children: selectedProvider.name
				}), (0, import_jsx_runtime.jsxs)("span", {
					className: `inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${configured ? "border-ok/30 bg-ok/10 text-ok" : "border-warn/30 bg-warn/10 text-warn"}`,
					children: [(0, import_jsx_runtime.jsx)("span", { className: `h-1.5 w-1.5 rounded-full ${configured ? "bg-ok" : "bg-warn"}` }), configured ? t("config-field.Configured") : t("mediasettingssection.NeedsSetup")]
				})]
			}),
			(selectedProvider.validationErrors?.length || selectedProvider.validationWarnings?.length) && (0, import_jsx_runtime.jsxs)("div", {
				className: "mb-3 space-y-1.5",
				children: [selectedProvider.validationErrors?.map((issue, i) => (0, import_jsx_runtime.jsxs)("div", {
					role: "alert",
					className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "font-semibold",
							children: issue.field
						}),
						" —",
						" ",
						issue.message
					]
				}, `err-${i}`)), selectedProvider.validationWarnings?.map((issue, i) => (0, import_jsx_runtime.jsxs)("div", {
					role: "status",
					className: "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "font-semibold",
							children: issue.field
						}),
						" —",
						" ",
						issue.message
					]
				}, `warn-${i}`))]
			}),
			(0, import_jsx_runtime.jsx)(ConfigRenderer, {
				ref: configRef,
				schema,
				hints,
				values,
				setKeys,
				registry: defaultRegistry,
				pluginId: selectedProvider.id,
				onChange: (key, value) => handlePluginFieldChange(selectedProvider.id, key, String(value ?? "")),
				revealSecret: async (pluginId, key) => {
					try {
						const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/reveal`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ key })
						});
						if (!res.ok) return null;
						const json = await res.json();
						return typeof json.value === "string" ? json.value : null;
					} catch {
						return null;
					}
				}
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mt-3 flex items-center justify-between gap-3",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex min-w-0 items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-9 rounded-lg",
						onClick: () => void handleFetchModels(selectedProvider.id),
						disabled: modelsFetching,
						children: modelsFetching ? t("apikeyconfig.fetching") : t("apikeyconfig.fetchModels")
					}), modelsFetchResult && (0, import_jsx_runtime.jsx)("span", {
						"aria-live": "polite",
						className: `truncate text-xs-tight ${modelsFetchResult.tone === "error" ? "text-danger" : "text-ok"}`,
						children: modelsFetchResult.message
					})]
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					className: "h-9 rounded-lg font-semibold",
					onClick: () => handlePluginSave(selectedProvider.id),
					disabled: isSaving,
					children: isSaving ? t("common.saving") : saveSuccess ? t("common.saved") : t("common.save")
				})]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/cloud-model-schema.js
/**
* Cloud model tier schema + hints builder.
*
* The AI Model settings panel exposes 7 dropdowns (nano, small, medium, large,
* mega, responseHandler, actionPlanner). Each is a `ConfigRenderer` select
* field with the same shape — this module produces the schema and hints so
* the component stays readable.
*/
const DEFAULT_RESPONSE_HANDLER_MODEL = "__DEFAULT_RESPONSE_HANDLER__";
const DEFAULT_ACTION_PLANNER_MODEL = "__DEFAULT_ACTION_PLANNER__";
const TIER_KEYS = [
	"nano",
	"small",
	"medium",
	"large",
	"mega"
];
const TIER_LABELS = {
	nano: "Nano Model",
	small: "Small Model",
	medium: "Medium Model",
	large: "Large Model",
	mega: "Mega Model"
};
const TIER_DESCRIPTIONS = {
	nano: "Fastest, cheapest text tier.",
	small: "Default lightweight text tier.",
	medium: "Planning tier. Falls back to small.",
	large: "Primary high-capability text tier.",
	mega: "Future top tier. Falls back to large."
};
function formatOption(m) {
	return {
		value: m.id,
		label: m.name,
		description: `${m.provider} — ${m.description}`
	};
}
/**
* Build the JSONSchema + UI hints for the cloud model tier grid.
*
* `allChoices` is the union of every tier's catalog, de-duped by id, used by
* the override selectors (responseHandler, actionPlanner) which accept any
* model.
*/
function buildCloudModelSchema(options) {
	const tierOptions = {
		nano: options.nano ?? [],
		small: options.small ?? [],
		medium: options.medium ?? [],
		large: options.large ?? [],
		mega: options.mega ?? []
	};
	const allChoices = Array.from(new Map(TIER_KEYS.flatMap((k) => tierOptions[k]).map((m) => [m.id, m])).values());
	const properties = {};
	const hints = {};
	for (const key of TIER_KEYS) {
		properties[key] = {
			type: "string",
			enum: tierOptions[key].map((m) => m.id),
			description: TIER_DESCRIPTIONS[key]
		};
		hints[key] = {
			label: TIER_LABELS[key],
			width: "half",
			options: tierOptions[key].map(formatOption)
		};
	}
	properties.responseHandler = {
		type: "string",
		enum: [DEFAULT_RESPONSE_HANDLER_MODEL, ...allChoices.map((m) => m.id)],
		description: "Should-respond / response-handler override. Defaults to nano."
	};
	hints.responseHandler = {
		label: "Response Handler",
		width: "half",
		options: [{
			value: DEFAULT_RESPONSE_HANDLER_MODEL,
			label: "Default (Nano)",
			description: "Use the nano tier unless explicitly overridden."
		}, ...allChoices.map(formatOption)]
	};
	properties.actionPlanner = {
		type: "string",
		enum: [DEFAULT_ACTION_PLANNER_MODEL, ...allChoices.map((m) => m.id)],
		description: "Planning override. Defaults to medium."
	};
	hints.actionPlanner = {
		label: "Action Planner",
		width: "half",
		options: [{
			value: DEFAULT_ACTION_PLANNER_MODEL,
			label: "Default (Medium)",
			description: "Use the medium tier unless explicitly overridden."
		}, ...allChoices.map(formatOption)]
	};
	return {
		schema: {
			type: "object",
			properties,
			required: []
		},
		hints
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/utils/subscription-auth.js
function formatSubscriptionRequestError(err) {
	if (err instanceof Error) return err.message;
	return String(err);
}
function normalizeOpenAICallbackInput(input) {
	const trimmed = input.trim();
	if (!trimmed) return {
		ok: false,
		error: "subscriptionstatus.PasteCallbackUrlFromLocalhost"
	};
	const normalized = trimmed.startsWith("localhost:") || trimmed.startsWith("127.0.0.1:") ? `http://${trimmed}` : trimmed;
	if (!normalized.includes("://")) {
		if (normalized.length > 4096) return {
			ok: false,
			error: "subscriptionstatus.CallbackCodeTooLong"
		};
		return {
			ok: true,
			code: normalized
		};
	}
	let parsed;
	try {
		parsed = new URL(normalized);
	} catch {
		return {
			ok: false,
			error: "subscriptionstatus.InvalidCallbackUrl"
		};
	}
	if (!(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") || parsed.port !== "1455" || parsed.pathname !== "/auth/callback") return {
		ok: false,
		error: "subscriptionstatus.ExpectedCallbackUrl"
	};
	if (!parsed.searchParams.get("code")) return {
		ok: false,
		error: "subscriptionstatus.CallbackUrlMissingCode"
	};
	return {
		ok: true,
		code: normalized
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/SubscriptionStatus.js
function StatusIcon({ connected }) {
	return (0, import_jsx_runtime.jsx)("span", {
		className: connected ? "text-ok" : "text-warn",
		children: connected ? (0, import_jsx_runtime.jsx)(CheckCircle2, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		}) : (0, import_jsx_runtime.jsx)(AlertTriangle, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		})
	});
}
function SubscriptionProviderPanel({ connected, canDisconnect = true, externalNotice, configuredButInvalid, titleConnected, titleDisconnected, loginLabel, loginHint, connectedSummary, invalidWarning, noteWhenConnected, warningBanner, preOauthSlot, oauthInstructions, oauthInputPlaceholder, oauthInputType = "text", oauthCode, setOauthCode, oauthStarted, oauthError, oauthExchangeBusy, exchangeButtonLabel, exchangeBusyLabel, disconnecting, onStartOauth, onExchange, onResetFlow, onDisconnect, bodyOverride }) {
	const { t } = useApp();
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(StatusIcon, { connected }), (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs font-semibold",
						children: connected ? titleConnected : titleDisconnected
					})]
				}), connected && canDisconnect && (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "icon",
					className: "!mt-0 h-8 w-8 rounded-lg",
					onClick: onDisconnect,
					disabled: disconnecting,
					"aria-label": t("common.disconnect"),
					title: t("common.disconnect"),
					children: disconnecting ? (0, import_jsx_runtime.jsx)(Loader2, {
						className: "h-3.5 w-3.5 animate-spin",
						"aria-hidden": true
					}) : (0, import_jsx_runtime.jsx)(LogOut, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					})
				})]
			}),
			warningBanner,
			externalNotice,
			configuredButInvalid && (0, import_jsx_runtime.jsx)("div", {
				className: "text-xs text-warn",
				children: invalidWarning
			}),
			noteWhenConnected && connected && noteWhenConnected,
			preOauthSlot,
			bodyOverride ?? (connected ? (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted",
				children: connectedSummary
			}) : !oauthStarted ? (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-1.5",
				children: [
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "!mt-0 h-9 rounded-lg font-semibold",
						onClick: onStartOauth,
						children: loginLabel
					}),
					(0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight text-muted",
						children: loginHint
					}),
					oauthError && (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight text-danger",
						children: oauthError
					})
				]
			}) : (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-2",
				children: [
					oauthInstructions,
					(0, import_jsx_runtime.jsx)(Input, {
						type: oauthInputType,
						className: "h-9 rounded-lg bg-card text-xs",
						placeholder: oauthInputPlaceholder,
						value: oauthCode,
						onChange: (e) => setOauthCode(e.target.value)
					}),
					oauthError && (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight text-danger",
						children: oauthError
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "!mt-0 h-9 rounded-lg font-semibold",
							disabled: oauthExchangeBusy || !oauthCode.trim(),
							onClick: onExchange,
							children: oauthExchangeBusy ? exchangeBusyLabel : exchangeButtonLabel
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "!mt-0 h-9 rounded-lg",
							onClick: onResetFlow,
							children: t("onboarding.startOver")
						})]
					})
				]
			}))
		]
	});
}
function SubscriptionStatus({ resolvedSelectedId, subscriptionStatus, anthropicConnected, setAnthropicConnected, anthropicCliDetected, openaiConnected, setOpenaiConnected, handleSelectSubscription, loadSubscriptionStatus }) {
	const { setTimeout } = useTimeout();
	const { t } = useApp();
	const [subscriptionTab, setSubscriptionTab] = useState("token");
	const [setupTokenValue, setSetupTokenValue] = useState("");
	const [setupTokenSaving, setSetupTokenSaving] = useState(false);
	const [setupTokenSuccess, setSetupTokenSuccess] = useState(false);
	const [anthropicOAuthStarted, setAnthropicOAuthStarted] = useState(false);
	const [anthropicCode, setAnthropicCode] = useState("");
	const [anthropicError, setAnthropicError] = useState("");
	const [anthropicExchangeBusy, setAnthropicExchangeBusy] = useState(false);
	const [openaiOAuthStarted, setOpenaiOAuthStarted] = useState(false);
	const [openaiCallbackUrl, setOpenaiCallbackUrl] = useState("");
	const [openaiError, setOpenaiError] = useState("");
	const [openaiExchangeBusy, setOpenaiExchangeBusy] = useState(false);
	const [subscriptionDisconnecting, setSubscriptionDisconnecting] = useState(null);
	const disconnectingRef = useRef(subscriptionDisconnecting);
	useEffect(() => {
		disconnectingRef.current = subscriptionDisconnecting;
	}, [subscriptionDisconnecting]);
	const anthropicStatus = subscriptionStatus.find((s) => s.provider === "anthropic-subscription");
	const openaiStatus = subscriptionStatus.find((s) => s.provider === "openai-subscription" || s.provider === "openai-codex");
	const handleDisconnectSubscription = useCallback(async (providerId) => {
		if (disconnectingRef.current) return;
		setSubscriptionDisconnecting(providerId);
		setAnthropicError("");
		setOpenaiError("");
		try {
			await client.deleteSubscription(getStoredSubscriptionProvider(providerId));
			await loadSubscriptionStatus();
			if (providerId === "anthropic-subscription") {
				setAnthropicConnected(false);
				setAnthropicOAuthStarted(false);
				setAnthropicCode("");
			}
			if (providerId === "openai-subscription") {
				setOpenaiConnected(false);
				setOpenaiOAuthStarted(false);
				setOpenaiCallbackUrl("");
			}
			await client.restartAgent();
		} catch (err) {
			const msg = t("subscriptionstatus.DisconnectFailedError", { message: formatSubscriptionRequestError(err) });
			if (providerId === "anthropic-subscription") setAnthropicError(msg);
			if (providerId === "openai-subscription") setOpenaiError(msg);
		} finally {
			setSubscriptionDisconnecting(null);
		}
	}, [
		loadSubscriptionStatus,
		setAnthropicConnected,
		setOpenaiConnected,
		t
	]);
	const handleSaveSetupToken = useCallback(async () => {
		const code = setupTokenValue.trim();
		if (!code || setupTokenSaving) return;
		setSetupTokenSaving(true);
		setSetupTokenSuccess(false);
		setAnthropicError("");
		try {
			if (!(await client.submitAnthropicSetupToken(code)).success) {
				setAnthropicError(t("subscriptionstatus.FailedToSaveSetupToken"));
				return;
			}
			setSetupTokenSuccess(true);
			setSetupTokenValue("");
			await handleSelectSubscription("anthropic-subscription");
			await loadSubscriptionStatus();
			await client.restartAgent();
			setTimeout(() => setSetupTokenSuccess(false), 2e3);
		} catch (err) {
			setAnthropicError(t("subscriptionstatus.FailedToSaveTokenError", { message: formatSubscriptionRequestError(err) }));
		} finally {
			setSetupTokenSaving(false);
		}
	}, [
		handleSelectSubscription,
		loadSubscriptionStatus,
		setTimeout,
		setupTokenSaving,
		setupTokenValue,
		t
	]);
	const handleAnthropicStart = useCallback(async () => {
		setAnthropicError("");
		try {
			const { authUrl } = await client.startAnthropicLogin();
			if (authUrl) {
				await openExternalUrl(authUrl);
				setAnthropicOAuthStarted(true);
				return;
			}
			setAnthropicError(t("onboarding.failedToGetAuthUrl"));
		} catch (err) {
			setAnthropicError(t("onboarding.failedToStartLogin", { message: formatSubscriptionRequestError(err) }));
		}
	}, [t]);
	const handleAnthropicExchange = useCallback(async () => {
		const code = anthropicCode.trim();
		if (!code || anthropicExchangeBusy) return;
		setAnthropicExchangeBusy(true);
		setAnthropicError("");
		try {
			const result = await client.exchangeAnthropicCode(code);
			if (result.success) {
				setAnthropicConnected(true);
				setAnthropicOAuthStarted(false);
				setAnthropicCode("");
				await handleSelectSubscription("anthropic-subscription");
				await loadSubscriptionStatus();
				await client.restartAgent();
				return;
			}
			setAnthropicError(result.error ?? t("onboarding.exchangeFailed"));
		} catch (err) {
			setAnthropicError(t("onboarding.exchangeFailedWithMessage", { message: formatSubscriptionRequestError(err) }));
		} finally {
			setAnthropicExchangeBusy(false);
		}
	}, [
		anthropicCode,
		anthropicExchangeBusy,
		handleSelectSubscription,
		loadSubscriptionStatus,
		setAnthropicConnected,
		t
	]);
	const handleOpenAIStart = useCallback(async () => {
		setOpenaiError("");
		try {
			const { authUrl } = await client.startOpenAILogin();
			if (authUrl) {
				await openExternalUrl(authUrl);
				setOpenaiOAuthStarted(true);
				return;
			}
			setOpenaiError(t("onboarding.noAuthUrlReturned"));
		} catch (err) {
			setOpenaiError(t("onboarding.failedToStartLogin", { message: formatSubscriptionRequestError(err) }));
		}
	}, [t]);
	const handleOpenAIExchange = useCallback(async () => {
		if (openaiExchangeBusy) return;
		const normalized = normalizeOpenAICallbackInput(openaiCallbackUrl);
		if (normalized.ok === false) {
			setOpenaiError(t(normalized.error));
			return;
		}
		setOpenaiExchangeBusy(true);
		setOpenaiError("");
		try {
			const data = await client.exchangeOpenAICode(normalized.code);
			if (data.success) {
				setOpenaiConnected(true);
				setOpenaiOAuthStarted(false);
				setOpenaiCallbackUrl("");
				await handleSelectSubscription("openai-subscription");
				await loadSubscriptionStatus();
				await client.restartAgent();
				return;
			}
			const msg = data.error ?? t("onboarding.exchangeFailed");
			setOpenaiError(msg.includes("No active flow") ? t("onboarding.loginSessionExpired") : msg);
		} catch (err) {
			setOpenaiError(t("onboarding.exchangeFailedWithMessage", { message: formatSubscriptionRequestError(err) }));
		} finally {
			setOpenaiExchangeBusy(false);
		}
	}, [
		handleSelectSubscription,
		loadSubscriptionStatus,
		openaiCallbackUrl,
		openaiExchangeBusy,
		setOpenaiConnected,
		t
	]);
	const tokenTabBody = (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-2",
		children: [
			(0, import_jsx_runtime.jsx)(Label, {
				htmlFor: "subscription-setup-token-input",
				className: "text-xs font-semibold",
				children: t("onboarding.setupToken")
			}),
			(0, import_jsx_runtime.jsx)(Input, {
				id: "subscription-setup-token-input",
				type: "password",
				placeholder: t("subscriptionstatus.skAntOat01"),
				value: setupTokenValue,
				onChange: (e) => {
					setSetupTokenValue(e.target.value);
					setSetupTokenSuccess(false);
					setAnthropicError("");
				},
				className: "h-9 rounded-lg bg-card font-mono text-xs"
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "whitespace-pre-line text-xs-tight text-muted",
				children: t("onboarding.setupTokenInstructions")
			}),
			anthropicError && (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs-tight text-danger",
				children: anthropicError
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between",
				children: [(0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					className: "!mt-0 h-9 rounded-lg font-semibold",
					disabled: setupTokenSaving || !setupTokenValue.trim(),
					onClick: () => void handleSaveSetupToken(),
					children: setupTokenSaving ? t("common.saving") : t("subscriptionstatus.SaveToken")
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [setupTokenSaving && (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight text-muted",
						children: t("subscriptionstatus.SavingAmpRestart")
					}), setupTokenSuccess && (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight text-ok",
						children: t("common.saved")
					})]
				})]
			})
		]
	});
	const anthropicTabs = !anthropicConnected ? (0, import_jsx_runtime.jsx)("div", {
		className: "flex items-center gap-4 border-b border-border/40",
		children: [["token", t("onboarding.setupToken")], ["oauth", t("onboarding.oauthLogin")]].map(([id, label]) => {
			return (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: () => setSubscriptionTab(id),
				className: `-mb-px border-b-2 px-1 pb-2 text-xs font-medium transition-colors ${subscriptionTab === id ? "border-accent text-txt" : "border-transparent text-muted hover:text-txt"}`,
				children: label
			}, id);
		})
	}) : void 0;
	const openaiInstructions = (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-lg border border-border/40 bg-bg/40 px-3 py-2 text-xs-tight leading-relaxed text-muted",
		children: [
			t("subscriptionstatus.AfterLoggingInYo"),
			" ",
			(0, import_jsx_runtime.jsx)("code", {
				className: "rounded border border-border bg-card px-1 text-2xs",
				children: t("subscriptionstatus.localhost1455")
			}),
			t("subscriptionstatus.CopyTheEntireU")
		]
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "border-t border-border/40 pt-4",
		children: [resolvedSelectedId === "anthropic-subscription" && (0, import_jsx_runtime.jsx)(SubscriptionProviderPanel, {
			providerId: "anthropic-subscription",
			connected: anthropicConnected,
			canDisconnect: false,
			externalNotice: anthropicCliDetected && !anthropicConnected ? (0, import_jsx_runtime.jsxs)("div", {
				className: "rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 text-xs leading-relaxed",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold",
					children: t("subscriptionstatus.ClaudeCodeCliDetectedTitle")
				}), (0, import_jsx_runtime.jsx)("p", {
					className: "mt-1 text-muted",
					children: t("subscriptionstatus.ClaudeCodeCliDetectedBody")
				})]
			}) : void 0,
			configuredButInvalid: Boolean(anthropicStatus?.configured && !anthropicStatus.valid),
			titleConnected: t("subscriptionstatus.ConnectedToClaudeSubscription"),
			titleDisconnected: anthropicCliDetected ? t("subscriptionstatus.ClaudeCodeCliDetectedTitle") : t("subscriptionstatus.ClaudeSubscriptionTitle"),
			loginLabel: t("onboarding.loginWithAnthropic"),
			loginHint: t("subscriptionstatus.RequiresClaudePro"),
			connectedSummary: t("subscriptionstatus.YourClaudeSubscrip"),
			invalidWarning: t("subscriptionstatus.ClaudeSubscription"),
			warningBanner: (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-2 text-xs leading-relaxed",
				children: (0, import_jsx_runtime.jsx)("span", {
					className: "font-semibold",
					children: t("subscriptionstatus.ClaudeTosWarningShort")
				})
			}),
			preOauthSlot: anthropicTabs,
			oauthInstructions: (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted",
				children: t("subscriptionstatus.AfterLoggingInCo")
			}),
			oauthInputPlaceholder: t("subscriptionstatus.PasteTheAuthorizat"),
			oauthCode: anthropicCode,
			setOauthCode: (v) => {
				setAnthropicCode(v);
				setAnthropicError("");
			},
			oauthStarted: anthropicOAuthStarted,
			oauthError: anthropicError,
			oauthExchangeBusy: anthropicExchangeBusy,
			exchangeButtonLabel: t("common.connect"),
			exchangeBusyLabel: t("game.connecting"),
			disconnecting: subscriptionDisconnecting === "anthropic-subscription",
			onStartOauth: () => void handleAnthropicStart(),
			onExchange: () => void handleAnthropicExchange(),
			onResetFlow: () => {
				setAnthropicOAuthStarted(false);
				setAnthropicCode("");
				setAnthropicError("");
			},
			onDisconnect: () => void handleDisconnectSubscription("anthropic-subscription"),
			bodyOverride: !anthropicConnected && subscriptionTab === "token" ? tokenTabBody : void 0
		}), resolvedSelectedId === "openai-subscription" && (0, import_jsx_runtime.jsx)(SubscriptionProviderPanel, {
			providerId: "openai-subscription",
			connected: openaiConnected,
			canDisconnect: false,
			configuredButInvalid: Boolean(openaiStatus?.configured && !openaiStatus.valid),
			titleConnected: t("subscriptionstatus.ConnectedToChatGPTSubscription"),
			titleDisconnected: t("subscriptionstatus.ChatGPTSubscriptionTitle"),
			loginLabel: t("onboarding.loginWithOpenAI"),
			loginHint: t("subscriptionstatus.RequiresChatGPTPlu"),
			connectedSummary: t("subscriptionstatus.YourChatGPTSubscri"),
			invalidWarning: t("subscriptionstatus.ChatGPTSubscription"),
			noteWhenConnected: (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-lg border border-ok/30 bg-ok/5 px-2.5 py-2 text-xs leading-relaxed",
				children: t("subscriptionstatus.CodexAllAccess")
			}),
			oauthInstructions: openaiInstructions,
			oauthInputPlaceholder: t("subscriptionstatus.httpLocalhost145"),
			oauthCode: openaiCallbackUrl,
			setOauthCode: (v) => {
				setOpenaiCallbackUrl(v);
				setOpenaiError("");
			},
			oauthStarted: openaiOAuthStarted,
			oauthError: openaiError,
			oauthExchangeBusy: openaiExchangeBusy,
			exchangeButtonLabel: t("onboarding.completeLogin"),
			exchangeBusyLabel: t("subscriptionstatus.Completing"),
			disconnecting: subscriptionDisconnecting === "openai-subscription",
			onStartOauth: () => void handleOpenAIStart(),
			onExchange: () => void handleOpenAIExchange(),
			onResetFlow: () => {
				setOpenaiOAuthStarted(false);
				setOpenaiCallbackUrl("");
				setOpenaiError("");
			},
			onDisconnect: () => void handleDisconnectSubscription("openai-subscription")
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/ProviderSwitcher.js
const SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS = {
	"anthropic-subscription": "Claude Subscription",
	"openai-subscription": "ChatGPT Subscription"
};
function normalizeAiProviderPluginId(value) {
	return value.toLowerCase().replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
}
function getSubscriptionProviderLabel(provider, t) {
	const translated = t(provider.labelKey);
	if (translated !== provider.labelKey) return translated;
	return SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS[provider.id] ?? provider.id;
}
function readSubscriptionProvider(cfg) {
	const subscriptionProvider = asRecord(asRecord(cfg.agents)?.defaults)?.subscriptionProvider;
	return typeof subscriptionProvider === "string" && isSubscriptionProviderSelectionId(subscriptionProvider) ? subscriptionProvider : null;
}
function readConfigString(source, key) {
	const value = source?.[key];
	return typeof value === "string" ? value : "";
}
const PROVIDER_LIST_STATUS_ICON_CLASSES = {
	ok: "text-ok",
	warn: "text-warn",
	muted: "text-muted"
};
function ProviderStatusGlyph({ current, status, tone }) {
	const label = current ? "Active" : status;
	const Icon = current || tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertCircle : Circle;
	return (0, import_jsx_runtime.jsx)("span", {
		className: `inline-flex h-5 w-5 shrink-0 items-center justify-center ${current ? "text-accent" : PROVIDER_LIST_STATUS_ICON_CLASSES[tone]}`,
		title: label,
		"aria-hidden": true,
		children: (0, import_jsx_runtime.jsx)(Icon, { className: "h-3.5 w-3.5" })
	});
}
function ProviderListItem({ id, icon: Icon, label, description, selected, current, status, tone, onSelect }) {
	const stateLabel = current ? "Active" : status;
	return (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		"aria-current": selected ? "true" : void 0,
		"aria-label": `${label}, ${stateLabel}`,
		onClick: () => onSelect(id),
		title: `${label} · ${stateLabel} · ${description}`,
		className: `flex h-10 w-full items-center gap-2 rounded-lg border px-2 text-left transition-colors ${selected ? "border-accent/45 bg-accent/10" : "border-border/45 bg-card/35 hover:border-border hover:bg-card/70"}`,
		children: [
			(0, import_jsx_runtime.jsx)("span", {
				className: `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${current ? "bg-accent/10 text-accent" : "bg-bg/60 text-muted"}`,
				children: (0, import_jsx_runtime.jsx)(Icon, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				})
			}),
			(0, import_jsx_runtime.jsx)("span", {
				className: "min-w-0 flex-1 truncate text-sm font-medium text-txt",
				children: label
			}),
			(0, import_jsx_runtime.jsx)(ProviderStatusGlyph, {
				current,
				status,
				tone
			})
		]
	});
}
function ProviderPanelHeader({ icon: Icon, title, description, children }) {
	return (0, import_jsx_runtime.jsxs)("header", {
		className: "flex min-h-12 items-center justify-between gap-3 border-border/40 border-b px-3 py-2 sm:px-4",
		title: description,
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 items-center gap-2.5",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted",
				children: (0, import_jsx_runtime.jsx)(Icon, {
					className: "h-4 w-4",
					"aria-hidden": true
				})
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "min-w-0",
				children: (0, import_jsx_runtime.jsx)("h3", {
					className: "truncate font-semibold text-sm text-txt",
					children: title
				})
			})]
		}), children ? (0, import_jsx_runtime.jsx)("div", {
			className: "shrink-0",
			children
		}) : null]
	});
}
function ProviderSwitcher(props = {}) {
	const { setTimeout } = useTimeout();
	const app = useApp();
	const branding = useBranding();
	const t = app.t;
	const elizaCloudConnected = props.elizaCloudConnected ?? Boolean(app.elizaCloudConnected);
	const plugins = Array.isArray(props.plugins) ? props.plugins : Array.isArray(app.plugins) ? app.plugins : [];
	const pluginSaving = props.pluginSaving ?? (app.pluginSaving instanceof Set ? app.pluginSaving : /* @__PURE__ */ new Set());
	const pluginSaveSuccess = props.pluginSaveSuccess ?? (app.pluginSaveSuccess instanceof Set ? app.pluginSaveSuccess : /* @__PURE__ */ new Set());
	const loadPlugins = props.loadPlugins ?? app.loadPlugins;
	const handlePluginConfigSave = props.handlePluginConfigSave ?? app.handlePluginConfigSave;
	const setActionNotice = app.setActionNotice;
	const [modelOptions, setModelOptions] = useState(null);
	const [currentNanoModel, setCurrentNanoModel] = useState("");
	const [currentSmallModel, setCurrentSmallModel] = useState("");
	const [currentMediumModel, setCurrentMediumModel] = useState("");
	const [currentLargeModel, setCurrentLargeModel] = useState("");
	const [currentMegaModel, setCurrentMegaModel] = useState("");
	const [currentResponseHandlerModel, setCurrentResponseHandlerModel] = useState(DEFAULT_RESPONSE_HANDLER_MODEL);
	const [currentActionPlannerModel, setCurrentActionPlannerModel] = useState(DEFAULT_ACTION_PLANNER_MODEL);
	const [modelSaving, setModelSaving] = useState(false);
	const [modelSaveSuccess, setModelSaveSuccess] = useState(false);
	const [cloudCallsDisabled, setCloudCallsDisabled] = useState(false);
	const [routingModeSaving, setRoutingModeSaving] = useState(false);
	const [localEmbeddings, setLocalEmbeddings] = useState(false);
	const [subscriptionStatus, setSubscriptionStatus] = useState([]);
	const [anthropicConnected, setAnthropicConnected] = useState(false);
	const [anthropicCliDetected, setAnthropicCliDetected] = useState(false);
	const [openaiConnected, setOpenaiConnected] = useState(false);
	const hasManualSelection = useRef(false);
	const [selectedProviderId, setSelectedProviderId] = useState(null);
	const hasManualPanelSelection = useRef(false);
	const [selectedProviderPanelId, setSelectedProviderPanelId] = useState(null);
	const readCloudCallsDisabled = useCallback((cfg) => {
		const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
		if (llmText?.transport === "cloud-proxy" || llmText?.transport === "direct" || llmText?.transport === "remote") return false;
		const cloud = asRecord(cfg.cloud);
		const services = asRecord(cloud?.services);
		return Boolean(cloud?.inferenceMode === "local" || services?.inference === false);
	}, []);
	const readLocalEmbeddingsFromConfig = useCallback((cfg) => {
		const embeddings = resolveServiceRoutingInConfig(cfg)?.embeddings;
		if (embeddings === void 0) return true;
		return !(embeddings.transport === "cloud-proxy" && embeddings.backend === "elizacloud");
	}, []);
	const syncSelectionFromConfig = useCallback((cfg) => {
		const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
		const providerId = getOnboardingProviderOption$1(llmText?.backend)?.id;
		const savedSubscriptionProvider = readSubscriptionProvider(cfg);
		const nextSelectedId = llmText?.transport === "cloud-proxy" && providerId === "elizacloud" ? "__cloud__" : llmText?.transport === "direct" ? providerId ?? null : llmText?.transport === "remote" && providerId ? providerId : savedSubscriptionProvider;
		if (!hasManualSelection.current) setSelectedProviderId(nextSelectedId);
		setCloudCallsDisabled(readCloudCallsDisabled(cfg));
		setLocalEmbeddings(readLocalEmbeddingsFromConfig(cfg));
	}, [readCloudCallsDisabled, readLocalEmbeddingsFromConfig]);
	const loadSubscriptionStatus = useCallback(async () => {
		try {
			setSubscriptionStatus((await client.getSubscriptionStatus()).providers ?? []);
		} catch (err) {
			console.warn("[eliza] Failed to load subscription status", err);
		}
	}, []);
	useEffect(() => {
		loadSubscriptionStatus();
		(async () => {
			try {
				const opts = await client.getOnboardingOptions();
				setModelOptions({
					nano: opts.models?.nano ?? [],
					small: opts.models?.small ?? [],
					medium: opts.models?.medium ?? [],
					large: opts.models?.large ?? [],
					mega: opts.models?.mega ?? []
				});
			} catch (err) {
				console.warn("[eliza] Failed to load onboarding options", err);
			}
			try {
				const cfg = await client.getConfig();
				const models = asRecord(cfg.models);
				const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
				const providerId = getOnboardingProviderOption$1(llmText?.backend)?.id;
				const elizaCloudEnabledCfg = llmText?.transport === "cloud-proxy" && providerId === "elizacloud";
				const defaults = {
					nano: "openai/gpt-5.5-nano",
					small: "minimax/minimax-m2.7",
					medium: "anthropic/claude-sonnet-4.6",
					large: "moonshotai/kimi-k2.5",
					mega: "anthropic/claude-opus-4-7"
				};
				const vars = asRecord(asRecord(cfg.env)?.vars);
				const envFor = (key) => readConfigString(vars, key);
				setCurrentNanoModel(readConfigString(models, "nano") || llmText?.nanoModel || envFor("NANO_MODEL") || (elizaCloudEnabledCfg ? defaults.nano : ""));
				setCurrentSmallModel(readConfigString(models, "small") || llmText?.smallModel || envFor("SMALL_MODEL") || (elizaCloudEnabledCfg ? defaults.small : ""));
				setCurrentMediumModel(readConfigString(models, "medium") || llmText?.mediumModel || envFor("MEDIUM_MODEL") || (elizaCloudEnabledCfg ? defaults.medium : ""));
				setCurrentLargeModel(readConfigString(models, "large") || llmText?.largeModel || envFor("LARGE_MODEL") || (elizaCloudEnabledCfg ? defaults.large : ""));
				setCurrentMegaModel(readConfigString(models, "mega") || llmText?.megaModel || envFor("MEGA_MODEL") || (elizaCloudEnabledCfg ? defaults.mega : ""));
				setCurrentResponseHandlerModel(llmText?.responseHandlerModel || DEFAULT_RESPONSE_HANDLER_MODEL);
				setCurrentActionPlannerModel(llmText?.actionPlannerModel || DEFAULT_ACTION_PLANNER_MODEL);
				syncSelectionFromConfig(cfg);
			} catch (err) {
				console.warn("[eliza] Failed to load config", err);
			}
		})();
	}, [loadSubscriptionStatus, syncSelectionFromConfig]);
	useEffect(() => {
		const anthStatus = subscriptionStatus.find((s) => s.provider === "anthropic-subscription");
		const oaiStatus = subscriptionStatus.find((s) => s.provider === "openai-subscription" || s.provider === "openai-codex");
		setAnthropicConnected(Boolean(anthStatus?.configured && anthStatus?.valid && anthStatus?.source === "app"));
		setAnthropicCliDetected(Boolean(anthStatus?.configured && anthStatus?.valid && anthStatus?.source === "claude-code-cli"));
		setOpenaiConnected(Boolean(oaiStatus?.configured && oaiStatus?.valid));
	}, [subscriptionStatus]);
	const allAiProviders = useMemo(() => [...plugins.filter((p) => p.category === "ai-provider")].sort((left, right) => {
		const leftCatalog = getOnboardingProviderOption$1(normalizeAiProviderPluginId(left.id));
		const rightCatalog = getOnboardingProviderOption$1(normalizeAiProviderPluginId(right.id));
		if (leftCatalog && rightCatalog) return leftCatalog.order - rightCatalog.order;
		if (leftCatalog) return -1;
		if (rightCatalog) return 1;
		return left.name.localeCompare(right.name);
	}), [plugins]);
	const availableProviderIds = useMemo(() => new Set(allAiProviders.map((provider) => getOnboardingProviderOption$1(normalizeAiProviderPluginId(provider.id))?.id).filter((id) => id != null)), [allAiProviders]);
	const resolvedSelectedId = useMemo(() => selectedProviderId === "__cloud__" ? "__cloud__" : selectedProviderId && (availableProviderIds.has(selectedProviderId) || isSubscriptionProviderSelectionId(selectedProviderId)) ? selectedProviderId : null, [availableProviderIds, selectedProviderId]);
	const restoreSelection = useCallback((previousSelectedId, previousManualSelection) => {
		hasManualSelection.current = previousManualSelection;
		setSelectedProviderId(previousSelectedId);
	}, []);
	const notifySelectionFailure = useCallback((prefix, err) => {
		const message = err instanceof Error && err.message.trim() ? `${prefix}: ${err.message}` : prefix;
		setActionNotice?.(message, "error", 6e3);
	}, [setActionNotice]);
	const handleSwitchProvider = useCallback(async (newId) => {
		const previousSelectedId = resolvedSelectedId;
		const previousManualSelection = hasManualSelection.current;
		const previousCloudCallsDisabled = cloudCallsDisabled;
		hasManualSelection.current = true;
		setSelectedProviderId(newId);
		setCloudCallsDisabled(false);
		const providerId = getOnboardingProviderOption$1(normalizeAiProviderPluginId((allAiProviders.find((provider) => (getOnboardingProviderOption$1(normalizeAiProviderPluginId(provider.id))?.id ?? normalizeAiProviderPluginId(provider.id)) === newId) ?? null)?.id ?? newId))?.id ?? newId;
		try {
			await client.switchProvider(providerId);
		} catch (err) {
			restoreSelection(previousSelectedId, previousManualSelection);
			setCloudCallsDisabled(previousCloudCallsDisabled);
			notifySelectionFailure("Failed to switch AI provider", err);
		}
	}, [
		allAiProviders,
		cloudCallsDisabled,
		notifySelectionFailure,
		resolvedSelectedId,
		restoreSelection
	]);
	const handleSelectSubscription = useCallback(async (providerId, activate = true) => {
		if (!cloudCallsDisabled && resolvedSelectedId === providerId) return;
		const previousSelectedId = resolvedSelectedId;
		const previousManualSelection = hasManualSelection.current;
		const previousCloudCallsDisabled = cloudCallsDisabled;
		hasManualSelection.current = true;
		setSelectedProviderId(providerId);
		if (!activate) return;
		setCloudCallsDisabled(false);
		try {
			await client.switchProvider(providerId);
		} catch (err) {
			restoreSelection(previousSelectedId, previousManualSelection);
			setCloudCallsDisabled(previousCloudCallsDisabled);
			notifySelectionFailure("Failed to update subscription provider", err);
		}
	}, [
		cloudCallsDisabled,
		notifySelectionFailure,
		resolvedSelectedId,
		restoreSelection
	]);
	const handleSelectCloud = useCallback(async () => {
		if (!cloudCallsDisabled && resolvedSelectedId === "__cloud__") return;
		const previousSelectedId = resolvedSelectedId;
		const previousManualSelection = hasManualSelection.current;
		const previousCloudCallsDisabled = cloudCallsDisabled;
		hasManualSelection.current = true;
		setSelectedProviderId("__cloud__");
		setCloudCallsDisabled(false);
		setRoutingModeSaving(true);
		try {
			await client.switchProvider("elizacloud");
		} catch (err) {
			restoreSelection(previousSelectedId, previousManualSelection);
			setCloudCallsDisabled(previousCloudCallsDisabled);
			notifySelectionFailure("Failed to select Eliza Cloud", err);
		} finally {
			setRoutingModeSaving(false);
		}
	}, [
		cloudCallsDisabled,
		notifySelectionFailure,
		resolvedSelectedId,
		restoreSelection
	]);
	const handleSelectLocalOnly = useCallback(async () => {
		const previousSelectedId = resolvedSelectedId;
		const previousManualSelection = hasManualSelection.current;
		const previousCloudCallsDisabled = cloudCallsDisabled;
		hasManualSelection.current = true;
		setCloudCallsDisabled(true);
		setRoutingModeSaving(true);
		try {
			const cloud = asRecord((await client.getConfig()).cloud) ?? {};
			const services = asRecord(cloud.services) ?? {};
			await client.updateConfig({
				deploymentTarget: { runtime: "local" },
				cloud: {
					...cloud,
					enabled: false,
					inferenceMode: "local",
					services: {
						...services,
						inference: false,
						media: false,
						tts: false,
						embeddings: false,
						rpc: false
					}
				},
				serviceRouting: null
			});
			client.restartAgent().catch((err) => {
				notifySelectionFailure("Local-only mode saved; restart failed", err);
			});
		} catch (err) {
			restoreSelection(previousSelectedId, previousManualSelection);
			setCloudCallsDisabled(previousCloudCallsDisabled);
			notifySelectionFailure("Failed to enable local-only mode", err);
		} finally {
			setRoutingModeSaving(false);
		}
	}, [
		cloudCallsDisabled,
		notifySelectionFailure,
		resolvedSelectedId,
		restoreSelection
	]);
	const handleToggleLocalEmbeddings = useCallback(async (nextValue) => {
		const previous = localEmbeddings;
		setLocalEmbeddings(nextValue);
		try {
			await client.switchProvider("elizacloud", void 0, void 0, { useLocalEmbeddings: nextValue });
		} catch (err) {
			setLocalEmbeddings(previous);
			notifySelectionFailure("Failed to update embeddings preference", err);
		}
	}, [localEmbeddings, notifySelectionFailure]);
	const isCloudSelected = resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
	const activeProviderPanelId = cloudCallsDisabled ? "__local__" : resolvedSelectedId ?? "__cloud__";
	const visibleProviderPanelId = selectedProviderPanelId ?? activeProviderPanelId;
	useEffect(() => {
		if (hasManualPanelSelection.current) return;
		setSelectedProviderPanelId(activeProviderPanelId);
	}, [activeProviderPanelId]);
	const apiProviderChoices = useMemo(() => allAiProviders.map((provider) => {
		const option = getOnboardingProviderOption$1(normalizeAiProviderPluginId(provider.id));
		return option ? {
			id: option.id,
			label: option.name,
			provider
		} : null;
	}).filter((choice) => choice !== null), [allAiProviders]);
	const selectedPanelProvider = useMemo(() => {
		if (visibleProviderPanelId === "__cloud__" || visibleProviderPanelId === "__local__" || isSubscriptionProviderSelectionId(visibleProviderPanelId)) return null;
		return apiProviderChoices.find((choice) => choice.id === visibleProviderPanelId)?.provider ?? null;
	}, [apiProviderChoices, visibleProviderPanelId]);
	const getSubscriptionPanelStatus = useCallback((providerId) => {
		const status = subscriptionStatus.find((entry) => providerId === "openai-subscription" ? entry.provider === "openai-subscription" || entry.provider === "openai-codex" : entry.provider === providerId);
		if (providerId === "anthropic-subscription" && anthropicCliDetected) return {
			label: "CLI detected",
			tone: "ok"
		};
		if (status?.configured && status.valid) return {
			label: "Connected",
			tone: "ok"
		};
		if (status?.configured && !status.valid) return {
			label: "Needs repair",
			tone: "warn"
		};
		return {
			label: "Not connected",
			tone: "muted"
		};
	}, [anthropicCliDetected, subscriptionStatus]);
	const handleProviderPanelSelect = useCallback((panelId) => {
		hasManualPanelSelection.current = true;
		setSelectedProviderPanelId(panelId);
	}, []);
	const cloudModelSchema = useMemo(() => modelOptions ? buildCloudModelSchema(modelOptions) : null, [modelOptions]);
	const largeModelOptions = modelOptions?.large ?? [];
	const modelValues = useMemo(() => {
		const values = {};
		const setKeys = /* @__PURE__ */ new Set();
		const put = (key, value) => {
			if (value) {
				values[key] = value;
				setKeys.add(key);
			}
		};
		put("nano", currentNanoModel);
		put("small", currentSmallModel);
		put("medium", currentMediumModel);
		put("large", currentLargeModel);
		put("mega", currentMegaModel);
		put("responseHandler", currentResponseHandlerModel);
		put("actionPlanner", currentActionPlannerModel);
		return {
			values,
			setKeys
		};
	}, [
		currentActionPlannerModel,
		currentLargeModel,
		currentMediumModel,
		currentMegaModel,
		currentNanoModel,
		currentResponseHandlerModel,
		currentSmallModel
	]);
	const handleModelFieldChange = useCallback((key, value) => {
		const val = String(value);
		const next = {
			nano: key === "nano" ? val : currentNanoModel,
			small: key === "small" ? val : currentSmallModel,
			medium: key === "medium" ? val : currentMediumModel,
			large: key === "large" ? val : currentLargeModel,
			mega: key === "mega" ? val : currentMegaModel,
			responseHandler: key === "responseHandler" ? val : currentResponseHandlerModel,
			actionPlanner: key === "actionPlanner" ? val : currentActionPlannerModel
		};
		if (key === "nano") setCurrentNanoModel(val);
		if (key === "small") setCurrentSmallModel(val);
		if (key === "medium") setCurrentMediumModel(val);
		if (key === "large") setCurrentLargeModel(val);
		if (key === "mega") setCurrentMegaModel(val);
		if (key === "responseHandler") setCurrentResponseHandlerModel(val);
		if (key === "actionPlanner") setCurrentActionPlannerModel(val);
		(async () => {
			setModelSaving(true);
			try {
				const cfg = await client.getConfig();
				const existingRouting = resolveServiceRoutingInConfig(cfg)?.llmText;
				const llmText = buildElizaCloudServiceRoute({
					nanoModel: next.nano,
					smallModel: next.small,
					mediumModel: next.medium,
					largeModel: next.large,
					megaModel: next.mega,
					...next.responseHandler !== DEFAULT_RESPONSE_HANDLER_MODEL ? { responseHandlerModel: next.responseHandler } : {},
					...next.actionPlanner !== DEFAULT_ACTION_PLANNER_MODEL ? { actionPlannerModel: next.actionPlanner } : {},
					...existingRouting?.shouldRespondModel ? { shouldRespondModel: existingRouting.shouldRespondModel } : {},
					...existingRouting?.plannerModel ? { plannerModel: existingRouting.plannerModel } : {},
					...existingRouting?.responseModel ? { responseModel: existingRouting.responseModel } : {},
					...existingRouting?.mediaDescriptionModel ? { mediaDescriptionModel: existingRouting.mediaDescriptionModel } : {}
				});
				await client.updateConfig({
					models: {
						nano: next.nano,
						small: next.small,
						medium: next.medium,
						large: next.large,
						mega: next.mega
					},
					serviceRouting: {
						...normalizeServiceRoutingConfig(cfg.serviceRouting) ?? {},
						llmText
					}
				});
				setModelSaveSuccess(true);
				setTimeout(() => setModelSaveSuccess(false), 2e3);
				await client.restartAgent();
			} catch (err) {
				notifySelectionFailure("Failed to save cloud model config", err);
			}
			setModelSaving(false);
		})();
	}, [
		currentActionPlannerModel,
		currentLargeModel,
		currentMediumModel,
		currentMegaModel,
		currentNanoModel,
		currentResponseHandlerModel,
		currentSmallModel,
		notifySelectionFailure,
		setTimeout
	]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-3",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "grid gap-3 xl:grid-cols-[240px_minmax(0,1fr)]",
			children: [(0, import_jsx_runtime.jsxs)("aside", {
				className: "flex min-w-0 flex-col gap-3",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1.5",
						children: [
							(0, import_jsx_runtime.jsx)("div", {
								className: "text-[10px] text-muted font-medium uppercase tracking-wider",
								children: "Providers"
							}),
							(0, import_jsx_runtime.jsx)(ProviderListItem, {
								id: "__cloud__",
								icon: Cloud,
								label: "Eliza Cloud",
								description: "Managed models, credits, and cloud fallback.",
								selected: visibleProviderPanelId === "__cloud__",
								current: !cloudCallsDisabled && isCloudSelected,
								status: elizaCloudConnected ? "Connected" : "Available",
								tone: elizaCloudConnected ? "ok" : "muted",
								onSelect: handleProviderPanelSelect
							}),
							(0, import_jsx_runtime.jsx)(ProviderListItem, {
								id: "__local__",
								icon: Cpu,
								label: "Local provider",
								description: "Downloaded models, routing, and offline inference.",
								selected: visibleProviderPanelId === "__local__",
								current: cloudCallsDisabled,
								status: "Available",
								tone: "muted",
								onSelect: handleProviderPanelSelect
							})
						]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1.5",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "text-[10px] text-muted font-medium uppercase tracking-wider",
							children: "Subscriptions"
						}), SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => {
							const status = getSubscriptionPanelStatus(provider.id);
							return (0, import_jsx_runtime.jsx)(ProviderListItem, {
								id: provider.id,
								icon: KeyRound,
								label: getSubscriptionProviderLabel(provider, t),
								description: provider.id === "anthropic-subscription" ? "Claude Code and task-agent access." : "ChatGPT/Codex subscription access.",
								selected: visibleProviderPanelId === provider.id,
								current: !cloudCallsDisabled && resolvedSelectedId === provider.id,
								status: status.label,
								tone: status.tone,
								onSelect: handleProviderPanelSelect
							}, provider.id);
						})]
					}),
					apiProviderChoices.length > 0 ? (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-1.5",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "text-[10px] text-muted font-medium uppercase tracking-wider",
							children: "API keys"
						}), apiProviderChoices.map((choice) => {
							const current = !cloudCallsDisabled && resolvedSelectedId === choice.id;
							const status = choice.provider.configured ? "API key set" : choice.provider.enabled ? "Enabled" : "Needs key";
							const tone = choice.provider.configured ? "ok" : "warn";
							return (0, import_jsx_runtime.jsx)(ProviderListItem, {
								id: choice.id,
								icon: KeyRound,
								label: choice.label,
								description: choice.provider.name,
								selected: visibleProviderPanelId === choice.id,
								current,
								status,
								tone,
								onSelect: handleProviderPanelSelect
							}, choice.id);
						})]
					}) : null
				]
			}), (0, import_jsx_runtime.jsxs)("section", {
				className: "min-w-0 overflow-hidden rounded-xl border border-border/40 bg-card/35",
				children: [
					visibleProviderPanelId === "__local__" ? (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)(ProviderPanelHeader, {
							icon: Cpu,
							title: "Local provider",
							description: "Manage local downloads, active models, routing, and device pairing in one place.",
							children: (0, import_jsx_runtime.jsxs)(Button, {
								type: "button",
								variant: cloudCallsDisabled ? "default" : "outline",
								className: "h-8 rounded-lg px-2.5 text-xs",
								disabled: routingModeSaving,
								"aria-label": cloudCallsDisabled ? "Local only active" : "Use local only",
								onClick: () => void handleSelectLocalOnly(),
								children: [(0, import_jsx_runtime.jsx)(ShieldCheck, {
									className: "h-4 w-4",
									"aria-hidden": true
								}), "Local only"]
							})
						}), (0, import_jsx_runtime.jsx)("div", {
							className: "px-3 py-3 sm:px-4",
							children: (0, import_jsx_runtime.jsx)(LocalInferencePanel, {})
						})]
					}) : null,
					visibleProviderPanelId === "__cloud__" ? (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [
							(0, import_jsx_runtime.jsx)(ProviderPanelHeader, {
								icon: Cloud,
								title: "Eliza Cloud",
								description: "Use managed models, cloud routing, and account credits.",
								children: (0, import_jsx_runtime.jsxs)(Button, {
									type: "button",
									variant: !cloudCallsDisabled && isCloudSelected ? "default" : "outline",
									className: "h-8 rounded-lg px-2.5 text-xs",
									disabled: routingModeSaving,
									"aria-label": !cloudCallsDisabled && isCloudSelected ? "Cloud active" : "Use Eliza Cloud",
									onClick: () => void handleSelectCloud(),
									children: [(0, import_jsx_runtime.jsx)(Cloud, {
										className: "h-4 w-4",
										"aria-hidden": true
									}), "Cloud"]
								})
							}),
							(0, import_jsx_runtime.jsx)(CloudDashboard, {}),
							!cloudCallsDisabled && isCloudSelected ? (0, import_jsx_runtime.jsx)("div", {
								className: "border-border/40 border-t px-4 py-3 sm:px-5",
								children: (0, import_jsx_runtime.jsx)(LocalEmbeddingsCheckbox, {
									checked: localEmbeddings,
									onCheckedChange: (v) => void handleToggleLocalEmbeddings(v)
								})
							}) : null,
							!cloudCallsDisabled && isCloudSelected && elizaCloudConnected && (largeModelOptions.length > 0 || cloudModelSchema) ? (0, import_jsx_runtime.jsxs)("div", {
								className: "border-border/40 border-t px-4 py-4 sm:px-5",
								children: [
									largeModelOptions.length > 0 ? (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("label", {
										htmlFor: "provider-switcher-primary-model",
										className: "mb-1.5 block text-muted text-xs font-medium uppercase tracking-wider",
										children: t("providerswitcher.model", { defaultValue: "Model" })
									}), (0, import_jsx_runtime.jsxs)(Select, {
										value: currentLargeModel || "",
										onValueChange: (v) => handleModelFieldChange("large", v),
										children: [(0, import_jsx_runtime.jsx)(SelectTrigger, {
											id: "provider-switcher-primary-model",
											className: "h-9 w-full max-w-sm rounded-lg border border-border bg-card text-sm",
											children: (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: t("providerswitcher.chooseModel", { defaultValue: "Choose a model" }) })
										}), (0, import_jsx_runtime.jsx)(SelectContent, {
											className: "max-h-64",
											children: largeModelOptions.map((model) => (0, import_jsx_runtime.jsx)(SelectItem, {
												value: model.id,
												children: model.name
											}, model.id))
										})]
									})] }) : null,
									cloudModelSchema ? (0, import_jsx_runtime.jsx)(AdvancedSettingsDisclosure, {
										title: "Model overrides",
										className: "mt-4",
										children: (0, import_jsx_runtime.jsx)(ConfigRenderer, {
											schema: cloudModelSchema.schema,
											hints: cloudModelSchema.hints,
											values: modelValues.values,
											setKeys: modelValues.setKeys,
											registry: defaultRegistry,
											onChange: handleModelFieldChange
										})
									}) : null,
									(0, import_jsx_runtime.jsxs)("div", {
										className: "mt-2 flex items-center justify-between gap-2",
										children: [(0, import_jsx_runtime.jsx)("p", {
											className: "text-muted text-xs-tight",
											children: t("providerswitcher.restartRequiredHint", appNameInterpolationVars(branding))
										}), (0, import_jsx_runtime.jsxs)("div", {
											className: "flex items-center gap-2",
											children: [modelSaving && (0, import_jsx_runtime.jsx)("span", {
												className: "inline-flex items-center text-muted",
												title: t("providerswitcher.savingRestarting"),
												role: "status",
												"aria-label": t("providerswitcher.savingRestarting"),
												children: (0, import_jsx_runtime.jsx)(Loader2, { className: "h-3.5 w-3.5 animate-spin" })
											}), modelSaveSuccess && (0, import_jsx_runtime.jsx)("span", {
												className: "inline-flex items-center text-ok",
												title: t("providerswitcher.savedRestartingAgent"),
												role: "status",
												"aria-label": t("providerswitcher.savedRestartingAgent"),
												children: (0, import_jsx_runtime.jsx)(CheckCircle2, { className: "h-3.5 w-3.5" })
											})]
										})]
									})
								]
							}) : null
						]
					}) : null,
					isSubscriptionProviderSelectionId(visibleProviderPanelId) ? (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)(ProviderPanelHeader, {
							icon: KeyRound,
							title: getSubscriptionProviderLabel(SUBSCRIPTION_PROVIDER_SELECTIONS.find((provider) => provider.id === visibleProviderPanelId) ?? SUBSCRIPTION_PROVIDER_SELECTIONS[0], t),
							description: "Connect subscription-backed access for models and task agents.",
							children: cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId ? (0, import_jsx_runtime.jsx)(Button, {
								type: "button",
								variant: "outline",
								className: "h-8 rounded-lg px-2.5 text-xs",
								onClick: () => void handleSelectSubscription(visibleProviderPanelId),
								children: "Use subscription"
							}) : null
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "px-3 py-3 sm:px-4",
							children: [
								cloudCallsDisabled ? (0, import_jsx_runtime.jsx)("div", {
									className: "mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight",
									children: "Local-only active. Remote subscription routing is paused."
								}) : null,
								(0, import_jsx_runtime.jsx)(SubscriptionStatus, {
									resolvedSelectedId: visibleProviderPanelId,
									subscriptionStatus,
									anthropicConnected,
									setAnthropicConnected,
									anthropicCliDetected,
									openaiConnected,
									setOpenaiConnected,
									handleSelectSubscription,
									loadSubscriptionStatus
								}),
								(() => {
									const selection = SUBSCRIPTION_PROVIDER_SELECTIONS.find((p) => p.id === visibleProviderPanelId);
									if (!selection) return null;
									return (0, import_jsx_runtime.jsx)(AccountList, { providerId: selection.storedProvider });
								})()
							]
						})]
					}) : null,
					selectedPanelProvider ? (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [(0, import_jsx_runtime.jsx)(ProviderPanelHeader, {
							icon: KeyRound,
							title: apiProviderChoices.find((choice) => choice.id === visibleProviderPanelId)?.label ?? selectedPanelProvider.name,
							description: "Use your own provider API key and model routing.",
							children: cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId ? (0, import_jsx_runtime.jsx)(Button, {
								type: "button",
								variant: "outline",
								className: "h-8 rounded-lg px-2.5 text-xs",
								onClick: () => void handleSwitchProvider(visibleProviderPanelId),
								children: "Use provider"
							}) : null
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "px-3 py-3 sm:px-4",
							children: [cloudCallsDisabled ? (0, import_jsx_runtime.jsx)("div", {
								className: "mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight",
								children: "Local-only active. Remote API routing is paused."
							}) : null, (0, import_jsx_runtime.jsx)(ApiKeyConfig, {
								selectedProvider: selectedPanelProvider,
								pluginSaving,
								pluginSaveSuccess,
								handlePluginConfigSave,
								loadPlugins
							})]
						})]
					}) : null
				]
			})]
		}), (0, import_jsx_runtime.jsx)(AdvancedSettingsDisclosure, {
			title: "Model settings",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col gap-3",
				children: [(0, import_jsx_runtime.jsx)(ProvidersList, {}), (0, import_jsx_runtime.jsx)(RoutingMatrix, {})]
			})
		})]
	});
}
const LOCAL_EMBEDDINGS_TOOLTIP = "Embeddings are vector representations of your messages, used for memory and search. Keeping them local means your message text isn't sent to the cloud just to compute vectors. Chat still goes through the cloud.";
function LocalEmbeddingsCheckbox({ checked, onCheckedChange }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-start gap-2.5 py-1",
		children: [(0, import_jsx_runtime.jsx)(Checkbox, {
			id: "provider-switcher-local-embeddings",
			checked,
			onCheckedChange: (value) => onCheckedChange(value === true),
			className: "mt-0.5 shrink-0",
			"aria-label": "Use local embeddings"
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 items-center gap-1.5",
			children: [(0, import_jsx_runtime.jsx)("label", {
				htmlFor: "provider-switcher-local-embeddings",
				className: "cursor-pointer text-xs-tight text-txt select-none",
				children: "Use local embeddings"
			}), (0, import_jsx_runtime.jsx)(TooltipHint, {
				content: LOCAL_EMBEDDINGS_TOOLTIP,
				side: "top",
				children: (0, import_jsx_runtime.jsx)("span", {
					className: "inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border/40 text-2xs text-muted hover:text-txt",
					"aria-hidden": "true",
					children: "?"
				})
			})]
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/SecuritySettingsSection.js
function formatRelativeTime(ms) {
	if (ms == null) return "local only";
	const diff = ms - Date.now();
	const absDiff = Math.abs(diff);
	const mins = Math.floor(absDiff / 6e4);
	const hours = Math.floor(absDiff / 36e5);
	const days = Math.floor(absDiff / 864e5);
	if (days > 0) return diff < 0 ? `${days}d ago` : `in ${days}d`;
	if (hours > 0) return diff < 0 ? `${hours}h ago` : `in ${hours}h`;
	if (mins > 0) return diff < 0 ? `${mins}m ago` : `in ${mins}m`;
	return diff < 0 ? "just now" : "soon";
}
function DeviceIcon({ userAgent }) {
	if (!userAgent) return (0, import_jsx_runtime.jsx)(Monitor, { className: "h-4 w-4 shrink-0 opacity-50" });
	const ua = userAgent.toLowerCase();
	if (/mobile|android|iphone|ipad/.test(ua)) return (0, import_jsx_runtime.jsx)(Smartphone, { className: "h-4 w-4 shrink-0 opacity-70" });
	return (0, import_jsx_runtime.jsx)(Laptop, { className: "h-4 w-4 shrink-0 opacity-70" });
}
const SECTION_CLASS = "rounded-lg border border-border/50 bg-bg/40 p-4 shadow-sm space-y-4 sm:p-5";
const SECTION_TITLE_CLASS = "flex items-center gap-2 text-sm font-semibold text-foreground/90";
const DIVIDER_CLASS = "border-t border-border/40";
function SectionShell({ icon, title, children }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: SECTION_CLASS,
		children: [
			(0, import_jsx_runtime.jsxs)("h3", {
				className: SECTION_TITLE_CLASS,
				children: [icon, title]
			}),
			(0, import_jsx_runtime.jsx)("div", { className: DIVIDER_CLASS }),
			children
		]
	});
}
async function fetchAccessState() {
	const result = await authMe();
	if (result.ok === true) return {
		phase: "loaded",
		identity: result.identity,
		access: result.access
	};
	if (result.ok === false && result.status === 401) return {
		phase: "locked",
		reason: result.reason === "remote_auth_required" || result.reason === "remote_password_not_configured" ? result.reason : null,
		access: result.access ?? null
	};
	return {
		phase: "error",
		message: "Security settings are unavailable while auth storage is offline."
	};
}
function parseAbsoluteUrl(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed);
	} catch {
		return null;
	}
}
function trimTrailingSlash(value) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
function isLoopbackHost(hostname) {
	const normalized = hostname.toLowerCase();
	return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}
function isAllInterfacesHost(hostname) {
	const normalized = hostname.toLowerCase();
	return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}
function isPrivateHost(hostname) {
	const normalized = hostname.toLowerCase();
	return normalized.startsWith("10.") || normalized.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) || normalized.endsWith(".local");
}
function securitySettingsUrl(origin) {
	return `${trimTrailingSlash(origin)}/settings#security`;
}
function describeEndpoint(url) {
	if (isAllInterfacesHost(url.hostname)) return {
		value: "All interfaces",
		detail: `${url.host}; use this machine's LAN, tailnet, or tunnel hostname from another device.`
	};
	if (isLoopbackHost(url.hostname)) return {
		value: "Loopback only",
		detail: `${url.host}; reachable from this machine only.`
	};
	if (isPrivateHost(url.hostname)) return {
		value: "LAN or tailnet",
		detail: `${url.host}; reachable where this private network permits.`
	};
	return {
		value: "Remote URL",
		detail: `${url.host}; remote browsers can use this address if firewall rules allow it.`
	};
}
function currentPageOrigin() {
	if (typeof window === "undefined") return null;
	const protocol = window.location.protocol;
	if (protocol !== "http:" && protocol !== "https:") return null;
	return window.location.origin;
}
function AccessInfoRow({ label, value, detail }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-1 border-t border-border/30 py-2.5 first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3",
		children: [(0, import_jsx_runtime.jsx)("div", {
			className: "text-xs font-medium uppercase tracking-wide text-muted-foreground",
			children: label
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0 space-y-0.5",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "break-words text-sm font-medium text-foreground/90",
				children: value
			}), (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs leading-5 text-muted-foreground",
				children: detail
			})]
		})]
	});
}
function StatusBadge$1({ children, tone = "neutral" }) {
	return (0, import_jsx_runtime.jsx)("span", {
		className: cn("inline-flex w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium", tone === "ok" && "border-[var(--ok-muted)] bg-[var(--ok-subtle)] text-ok", tone === "warn" && "border-warning/40 bg-warning/10 text-warning", tone === "danger" && "border-danger/40 bg-danger/10 text-danger", tone === "neutral" && "border-border/60 bg-bg/70 text-muted-foreground"),
		children
	});
}
function AccessModeSection({ state, onRefresh }) {
	const bootConfig = useBootConfig();
	let title = "Checking access";
	let detail = "Confirming how this browser is connected.";
	let status = "Checking";
	let statusTone = "neutral";
	let currentBrowserValue = "Checking";
	let currentBrowserDetail = "Waiting for the auth endpoint to identify this browser.";
	let remotePasswordValue = "Checking";
	let remotePasswordDetail = "Waiting for the auth endpoint to report remote password state.";
	let remotePasswordTone = "neutral";
	if (state.phase === "loaded") {
		if (state.access.mode === "local") {
			title = "Local access";
			detail = "This browser is on the host machine. Localhost and Electrobun access do not require a password. Remote browsers use the remote password below.";
			status = state.access.passwordConfigured ? "Remote password set" : "Remote password not set";
			statusTone = state.access.passwordConfigured ? "ok" : "warn";
			currentBrowserValue = "Local host";
			currentBrowserDetail = "The current browser is trusted because it is running from localhost or the desktop renderer.";
		} else {
			title = "Remote session";
			detail = "This browser is signed in remotely. Localhost and Electrobun still use local access on the host machine.";
			status = "Signed in";
			statusTone = "ok";
			currentBrowserValue = "Remote browser";
			currentBrowserDetail = "This session is authenticated with the configured remote password.";
		}
		remotePasswordValue = state.access.passwordConfigured ? "Set" : "Not set";
		remotePasswordDetail = state.access.passwordConfigured ? "Remote browsers can sign in with the configured password." : "Remote browsers cannot sign in until a remote password is set.";
		remotePasswordTone = state.access.passwordConfigured ? "ok" : "warn";
	} else if (state.phase === "locked") {
		title = "Remote access";
		detail = state.reason === "remote_password_not_configured" ? "Remote access is disabled until this instance is opened on the host machine and a remote password is set." : "Remote access requires a password session.";
		status = state.access?.passwordConfigured ? "Password required" : "Not set";
		statusTone = state.access?.passwordConfigured ? "warn" : "danger";
		currentBrowserValue = "Remote browser";
		currentBrowserDetail = state.reason === "remote_password_not_configured" ? "This browser is remote and no remote password is configured yet." : "This browser is remote and needs a password session.";
		remotePasswordValue = state.access?.passwordConfigured ? "Set" : "Not set";
		remotePasswordDetail = state.access?.passwordConfigured ? "Remote password exists; sign in to manage sessions and changes." : "Remote access is disabled until the host machine sets a password.";
		remotePasswordTone = state.access?.passwordConfigured ? "warn" : "danger";
	} else if (state.phase === "error") {
		title = "Access unavailable";
		detail = state.message;
		status = "Unavailable";
		statusTone = "danger";
		currentBrowserValue = "Unavailable";
		currentBrowserDetail = state.message;
		remotePasswordValue = "Unavailable";
		remotePasswordDetail = "The auth endpoint did not return password state.";
		remotePasswordTone = "danger";
	}
	const pageOrigin = currentPageOrigin();
	const pageUrl = pageOrigin ? securitySettingsUrl(pageOrigin) : null;
	const pageEndpoint = parseAbsoluteUrl(pageOrigin);
	const pageEndpointDescription = pageEndpoint ? describeEndpoint(pageEndpoint) : null;
	const apiBase = bootConfig.apiBase?.trim() || (pageOrigin ? trimTrailingSlash(pageOrigin) : null);
	const apiEndpoint = parseAbsoluteUrl(apiBase);
	const apiEndpointDescription = apiEndpoint ? describeEndpoint(apiEndpoint) : null;
	const pageUrlLabel = pageEndpoint && !isLoopbackHost(pageEndpoint.hostname) ? "Remote URL" : "Local URL";
	return (0, import_jsx_runtime.jsxs)(SectionShell, {
		icon: (0, import_jsx_runtime.jsx)(Shield, { className: "h-4 w-4 opacity-60" }),
		title: "Access",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0 space-y-1",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "text-sm font-medium text-foreground/90",
						children: title
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "max-w-2xl text-sm leading-6 text-muted-foreground",
						children: detail
					})]
				}), (0, import_jsx_runtime.jsx)(StatusBadge$1, {
					tone: statusTone,
					children: state.phase === "loading" ? (0, import_jsx_runtime.jsxs)("span", {
						className: "inline-flex items-center gap-1.5",
						children: [(0, import_jsx_runtime.jsx)(Loader2, { className: "h-3 w-3 animate-spin" }), status]
					}) : status
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "rounded-md border border-border/40 bg-bg/35 px-3",
				children: [
					(0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: "Current browser",
						value: currentBrowserValue,
						detail: currentBrowserDetail
					}),
					(0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: "Local access",
						value: "Enabled",
						detail: "Host-machine localhost and desktop renderer sessions do not require the remote password."
					}),
					(0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: "Remote password",
						value: (0, import_jsx_runtime.jsx)(StatusBadge$1, {
							tone: remotePasswordTone,
							children: remotePasswordValue
						}),
						detail: remotePasswordDetail
					}),
					pageUrl && pageEndpointDescription && (0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: pageUrlLabel,
						value: pageUrl,
						detail: pageEndpointDescription.detail
					}),
					apiBase && apiEndpointDescription && (0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: "API base",
						value: trimTrailingSlash(apiBase),
						detail: `${apiEndpointDescription.value}: ${apiEndpointDescription.detail}`
					}),
					state.phase === "loaded" && (0, import_jsx_runtime.jsx)(AccessInfoRow, {
						label: "Identity",
						value: state.identity.displayName,
						detail: `Signed in as ${state.identity.kind}.`
					})
				]
			}),
			(0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => void onRefresh(),
				className: "inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
				children: [(0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-3 w-3" }), "Refresh"]
			})
		]
	});
}
function SessionsSection() {
	const [state, setState] = useState({ phase: "loading" });
	const [revokingIds, setRevokingIds] = useState(/* @__PURE__ */ new Set());
	const load = useCallback(async () => {
		setState({ phase: "loading" });
		const result = await authListSessions();
		if (result.ok === true) setState({
			phase: "loaded",
			sessions: result.sessions
		});
		else if (result.ok === false) setState({
			phase: "error",
			message: result.status === 401 ? "You must be signed in to view sessions." : "Could not load sessions. Try reloading the page."
		});
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	const handleRevoke = useCallback(async (sessionId) => {
		setRevokingIds((prev) => new Set([...prev, sessionId]));
		const result = await authRevokeSession(sessionId);
		setRevokingIds((prev) => {
			const next = new Set(prev);
			next.delete(sessionId);
			return next;
		});
		if (result.ok) load();
	}, [load]);
	const handleRevokeOthers = useCallback(async () => {
		if (state.phase !== "loaded") return;
		const others = state.sessions.filter((s) => !s.current);
		for (const s of others) await handleRevoke(s.id);
	}, [state, handleRevoke]);
	return (0, import_jsx_runtime.jsxs)(SectionShell, {
		icon: (0, import_jsx_runtime.jsx)(Shield, { className: "h-4 w-4 opacity-60" }),
		title: "Active sessions",
		children: [
			state.phase === "loading" && (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 py-3 text-sm text-muted-foreground",
				children: [(0, import_jsx_runtime.jsx)(Loader2, { className: "h-4 w-4 animate-spin" }), "Loading sessions..."]
			}),
			state.phase === "error" && (0, import_jsx_runtime.jsx)("p", {
				className: "py-2 text-sm text-danger",
				children: state.message
			}),
			state.phase === "loaded" && (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-3",
				children: [state.sessions.length === 0 ? (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "No active sessions."
				}) : (0, import_jsx_runtime.jsx)("div", {
					className: "divide-y divide-border/30",
					children: state.sessions.map((session) => (0, import_jsx_runtime.jsx)(SessionRow, {
						session,
						revoking: revokingIds.has(session.id),
						onRevoke: handleRevoke
					}, session.id))
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between pt-1",
					children: [(0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: load,
						className: "inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
						children: [(0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-3 w-3" }), "Refresh"]
					}), state.sessions.filter((s) => !s.current).length > 1 && (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						onClick: handleRevokeOthers,
						className: "border-danger/40 text-xs text-danger hover:bg-danger/10",
						children: "Sign out everywhere else"
					})]
				})]
			})
		]
	});
}
function SessionRow({ session, revoking, onRevoke }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-start gap-3 py-3",
		children: [
			(0, import_jsx_runtime.jsx)(DeviceIcon, { userAgent: session.userAgent }),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 flex-1 flex-col gap-0.5",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "text-sm font-medium capitalize text-foreground/90",
							children: session.kind
						}), session.current && (0, import_jsx_runtime.jsx)("span", {
							className: "rounded-full border border-[var(--ok-muted)] bg-[var(--ok-subtle)] px-2 py-0.5 text-3xs font-medium uppercase tracking-[0.08em] text-ok",
							children: "This session"
						})]
					}),
					(0, import_jsx_runtime.jsxs)("p", {
						className: "truncate text-xs text-muted-foreground/80",
						children: [
							session.ip ?? "Unknown IP",
							" ·",
							" ",
							session.userAgent ? session.userAgent.slice(0, 60) : "Unknown client"
						]
					}),
					(0, import_jsx_runtime.jsxs)("p", {
						className: "text-xs text-muted-foreground/60",
						children: [
							"Last seen ",
							formatRelativeTime(session.lastSeenAt),
							" · expires",
							" ",
							formatRelativeTime(session.expiresAt)
						]
					})
				]
			}),
			!session.current && (0, import_jsx_runtime.jsx)(Button, {
				variant: "ghost",
				size: "sm",
				disabled: revoking,
				onClick: () => onRevoke(session.id),
				className: "shrink-0 text-xs text-danger hover:bg-danger/10 hover:text-danger",
				"aria-label": "Revoke this session",
				children: revoking ? (0, import_jsx_runtime.jsx)(Loader2, { className: "h-3 w-3 animate-spin" }) : (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3 w-3" })
			})
		]
	});
}
function RemotePasswordSection({ accessState, onAccessChanged }) {
	const displayNameId = useId().replace(/:/g, "");
	const currentPasswordId = useId().replace(/:/g, "");
	const newPasswordId = useId().replace(/:/g, "");
	const confirmPasswordId = useId().replace(/:/g, "");
	const [displayName, setDisplayName] = useState("Owner");
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [state, setState] = useState({ phase: "idle" });
	const loaded = accessState.phase === "loaded" ? accessState : null;
	const setupMode = loaded?.access.mode === "local" && !loaded.access.ownerConfigured;
	const localAccess = loaded?.access.mode === "local";
	const currentPasswordRequired = Boolean(loaded && !localAccess);
	const confirmMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
	const isSubmitting = state.phase === "submitting";
	const canSubmit = Boolean(loaded) && (!setupMode || displayName.trim().length > 0) && (!currentPasswordRequired || currentPassword.length > 0) && newPassword.length >= 12 && newPassword === confirmPassword && !isSubmitting;
	const handleSubmit = useCallback(async (event) => {
		event.preventDefault();
		if (!loaded) return;
		if (newPassword !== confirmPassword) {
			setState({
				phase: "error",
				message: "New passwords do not match."
			});
			return;
		}
		setState({ phase: "submitting" });
		const result = setupMode ? await authSetup({
			displayName: displayName.trim(),
			password: newPassword
		}) : await authChangePassword({
			currentPassword: currentPasswordRequired ? currentPassword : void 0,
			newPassword
		});
		if (result.ok === false) {
			setState({
				phase: "error",
				message: result.message
			});
			return;
		}
		setState({
			phase: "success",
			message: "Remote access is enabled. Remote browsers can sign in with this password when they can reach this instance."
		});
		setCurrentPassword("");
		setNewPassword("");
		setConfirmPassword("");
		await onAccessChanged();
	}, [
		confirmPassword,
		currentPassword,
		currentPasswordRequired,
		displayName,
		loaded,
		newPassword,
		onAccessChanged,
		setupMode
	]);
	if (accessState.phase === "loading") return (0, import_jsx_runtime.jsx)(SectionShell, {
		icon: (0, import_jsx_runtime.jsx)(KeyRound, { className: "h-4 w-4 opacity-60" }),
		title: "Remote password",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-2 py-3 text-sm text-muted-foreground",
			children: [(0, import_jsx_runtime.jsx)(Loader2, { className: "h-4 w-4 animate-spin" }), "Loading password settings..."]
		})
	});
	if (accessState.phase !== "loaded") {
		const message = accessState.phase === "locked" && accessState.reason === "remote_password_not_configured" ? "Remote access is not enabled yet. Open this instance on the host machine via localhost and set a remote password here." : "Sign in to manage the remote password.";
		return (0, import_jsx_runtime.jsx)(SectionShell, {
			icon: (0, import_jsx_runtime.jsx)(KeyRound, { className: "h-4 w-4 opacity-60" }),
			title: "Remote password",
			children: (0, import_jsx_runtime.jsx)("p", {
				className: "text-sm text-muted-foreground",
				children: message
			})
		});
	}
	const description = localAccess ? "Set the password used by browsers that connect to this instance from another machine. Localhost and Electrobun do not use it." : "Change the password for this remote browser session.";
	const buttonLabel = setupMode || !accessState.access.passwordConfigured ? "Set remote password" : "Change remote password";
	return (0, import_jsx_runtime.jsxs)(SectionShell, {
		icon: (0, import_jsx_runtime.jsx)(KeyRound, { className: "h-4 w-4 opacity-60" }),
		title: "Remote password",
		children: [(0, import_jsx_runtime.jsx)("p", {
			className: "text-sm leading-6 text-muted-foreground",
			children: description
		}), (0, import_jsx_runtime.jsxs)("form", {
			onSubmit: handleSubmit,
			className: "flex flex-col gap-3",
			noValidate: true,
			children: [
				setupMode && (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-1.5",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: displayNameId,
						className: "text-xs uppercase tracking-wide text-muted-foreground",
						children: "Display name"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: displayNameId,
						type: "text",
						autoComplete: "username",
						value: displayName,
						onChange: (event) => {
							setDisplayName(event.target.value);
							if (state.phase === "error") setState({ phase: "idle" });
						},
						disabled: isSubmitting
					})]
				}),
				currentPasswordRequired && (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-1.5",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: currentPasswordId,
						className: "text-xs uppercase tracking-wide text-muted-foreground",
						children: "Current password"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: currentPasswordId,
						type: "password",
						autoComplete: "current-password",
						value: currentPassword,
						onChange: (event) => {
							setCurrentPassword(event.target.value);
							if (state.phase === "error") setState({ phase: "idle" });
						},
						disabled: isSubmitting
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-1.5",
					children: [(0, import_jsx_runtime.jsx)(Label, {
						htmlFor: newPasswordId,
						className: "text-xs uppercase tracking-wide text-muted-foreground",
						children: "New password"
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: newPasswordId,
						type: "password",
						autoComplete: "new-password",
						placeholder: "At least 12 characters",
						value: newPassword,
						onChange: (event) => {
							setNewPassword(event.target.value);
							if (state.phase === "error") setState({ phase: "idle" });
						},
						disabled: isSubmitting
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-1.5",
					children: [
						(0, import_jsx_runtime.jsx)(Label, {
							htmlFor: confirmPasswordId,
							className: "text-xs uppercase tracking-wide text-muted-foreground",
							children: "Confirm new password"
						}),
						(0, import_jsx_runtime.jsx)(Input, {
							id: confirmPasswordId,
							type: "password",
							autoComplete: "new-password",
							value: confirmPassword,
							onChange: (event) => {
								setConfirmPassword(event.target.value);
								if (state.phase === "error") setState({ phase: "idle" });
							},
							disabled: isSubmitting,
							"aria-invalid": confirmMismatch,
							className: cn(confirmMismatch && "border-danger focus-visible:border-danger")
						}),
						confirmMismatch && (0, import_jsx_runtime.jsx)("p", {
							className: "text-xs text-danger",
							children: "Passwords do not match."
						})
					]
				}),
				state.phase === "error" && (0, import_jsx_runtime.jsx)("p", {
					role: "alert",
					className: "text-sm text-danger",
					children: state.message
				}),
				state.phase === "success" && (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-ok",
					children: state.message
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "flex justify-end pt-1",
					children: (0, import_jsx_runtime.jsx)(Button, {
						type: "submit",
						disabled: !canSubmit,
						size: "sm",
						children: isSubmitting ? "Saving..." : buttonLabel
					})
				})
			]
		})]
	});
}
function SecuritySettingsSection() {
	const [accessState, setAccessState] = useState({ phase: "loading" });
	const refreshAccessState = useCallback(async () => {
		setAccessState({ phase: "loading" });
		setAccessState(await fetchAccessState());
	}, []);
	useEffect(() => {
		refreshAccessState();
	}, [refreshAccessState]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsx)(AccessModeSection, {
				state: accessState,
				onRefresh: refreshAccessState
			}),
			(0, import_jsx_runtime.jsx)(RemotePasswordSection, {
				accessState,
				onAccessChanged: refreshAccessState
			}),
			(0, import_jsx_runtime.jsx)(SessionsSection, {})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/settings/WalletKeysSection.js
/**
* Wallet keys panel for Settings -> Wallet & RPC.
*
* Single source of truth: `/api/secrets/inventory?category=wallet`.
* Reveal / delete go through the same `/api/secrets/inventory/:key`
* endpoints the Vault tab uses, so toggling a value here shows up
* immediately in Settings -> Vault and vice versa.
*
* Scope: lists wallet-category vault entries (EVM_PRIVATE_KEY,
* SOLANA_PRIVATE_KEY, per-agent `agent.<id>.wallet.<chain>`) with a
* reveal-on-demand value display and an "Add wallet key" form.
*
* Per-agent address derivation is read from the entry's reveal payload
* (the per-agent storage shape is JSON with `{address, privateKey}`),
* so the panel doesn't need to bundle a key-derivation library on the
* client.
*/
function maskValue(value) {
	if (value.length <= 12) return "*".repeat(value.length);
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function tryExtractAgentAddress(rawValue) {
	if (!rawValue.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(rawValue);
		if (typeof parsed.address === "string" && parsed.address.length > 0) return parsed.address;
	} catch {}
	return null;
}
function entryDisplayLabel(meta) {
	if (meta.label && meta.label !== meta.key) return meta.label;
	const parts = meta.key.split(".");
	if (parts.length === 4 && parts[0] === "agent" && parts[2] === "wallet") return `${decodeURIComponent(parts[1] ?? "")} (${parts[3]})`;
	return meta.key;
}
function WalletKeysSection() {
	const [entries, setEntries] = useState(null);
	const [error, setError] = useState(null);
	const [revealMap, setRevealMap] = useState({});
	const [revealLoading, setRevealLoading] = useState({});
	const [showAdd, setShowAdd] = useState(false);
	const [addKey, setAddKey] = useState("");
	const [addValue, setAddValue] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const load = useCallback(async () => {
		setError(null);
		setEntries(null);
		try {
			const res = await fetch("/api/secrets/inventory?category=wallet");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (!Array.isArray(json.entries)) throw new Error("Invalid wallet inventory response");
			setEntries(json.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : "load failed");
			setEntries([]);
		}
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	const onReveal = useCallback(async (key) => {
		setRevealLoading((prev) => ({
			...prev,
			[key]: true
		}));
		try {
			const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(key)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			setRevealMap((prev) => ({
				...prev,
				[key]: json.value
			}));
			window.setTimeout(() => {
				setRevealMap((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
			}, 1e4);
		} catch (err) {
			setError(err instanceof Error ? err.message : "reveal failed");
		} finally {
			setRevealLoading((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		}
	}, []);
	const onHide = useCallback((key) => {
		setRevealMap((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	}, []);
	const onDelete = useCallback(async (entry) => {
		if (!window.confirm(`Delete wallet key "${entry.key}"? This cannot be undone.`)) return;
		const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(entry.key)}`, { method: "DELETE" });
		if (!res.ok) {
			setError(`HTTP ${res.status}`);
			return;
		}
		await load();
	}, [load]);
	const onAdd = useCallback(async (event) => {
		event.preventDefault();
		const key = addKey.trim();
		const value = addValue.trim();
		if (!key || !value) return;
		setSubmitting(true);
		setError(null);
		const res = await fetch(`/api/secrets/inventory/${encodeURIComponent(key)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				value,
				category: "wallet"
			})
		});
		setSubmitting(false);
		if (!res.ok) {
			setError(`HTTP ${res.status}`);
			return;
		}
		setAddKey("");
		setAddValue("");
		setShowAdd(false);
		await load();
	}, [
		addKey,
		addValue,
		load
	]);
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": "wallet-keys-section",
		className: "space-y-2",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-medium text-txt",
						children: "Wallet keys"
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Private keys stored in the local vault. Same data the Vault tab shows under \"Wallet\" — edit either place."
					})]
				}), (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 shrink-0 gap-1 rounded-md px-2",
					onClick: () => setShowAdd((v) => !v),
					"data-testid": "wallet-keys-add-toggle",
					children: [(0, import_jsx_runtime.jsx)(Plus, {
						className: "h-3.5 w-3.5",
						"aria-hidden": true
					}), "Add wallet key"]
				})]
			}),
			error && (0, import_jsx_runtime.jsx)("div", {
				"aria-live": "polite",
				"data-testid": "wallet-keys-error",
				className: "rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger",
				children: error
			}),
			showAdd && (0, import_jsx_runtime.jsxs)("form", {
				onSubmit: onAdd,
				className: "space-y-2 rounded-md border border-border/50 bg-card/30 p-2",
				"data-testid": "wallet-keys-add-form",
				children: [
					(0, import_jsx_runtime.jsxs)("p", {
						className: "text-2xs text-muted",
						children: [
							"Stored sensitively in the encrypted vault. Use the env-var name (e.g. ",
							(0, import_jsx_runtime.jsx)("code", { children: "EVM_PRIVATE_KEY" }),
							", ",
							(0, import_jsx_runtime.jsx)("code", { children: "SOLANA_PRIVATE_KEY" }),
							") so other surfaces pick it up automatically."
						]
					}),
					(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
						className: "text-2xs text-muted",
						children: "Key name"
					}), (0, import_jsx_runtime.jsx)(Input, {
						value: addKey,
						onChange: (e) => setAddKey(e.target.value),
						placeholder: "EVM_PRIVATE_KEY",
						className: "h-8 text-xs",
						autoComplete: "off",
						required: true
					})] }),
					(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(Label, {
						className: "text-2xs text-muted",
						children: "Private key"
					}), (0, import_jsx_runtime.jsx)(Input, {
						type: "password",
						value: addValue,
						onChange: (e) => setAddValue(e.target.value),
						className: "h-8 text-xs",
						autoComplete: "new-password",
						required: true
					})] }),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex justify-end gap-2 pt-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							className: "h-7 rounded-md px-3 text-xs",
							onClick: () => setShowAdd(false),
							disabled: submitting,
							children: "Cancel"
						}), (0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							variant: "default",
							size: "sm",
							className: "h-7 gap-1 rounded-md px-3 text-xs",
							disabled: submitting || !addKey.trim() || !addValue.trim(),
							children: submitting ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Loader2, {
								className: "h-3.5 w-3.5 animate-spin",
								"aria-hidden": true
							}), "Saving…"] }) : "Save"
						})]
					})
				]
			}),
			entries === null ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-1 py-3 text-xs text-muted",
				children: [(0, import_jsx_runtime.jsx)(Loader2, {
					className: "h-3.5 w-3.5 animate-spin",
					"aria-hidden": true
				}), " Loading…"]
			}) : entries.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
				"data-testid": "wallet-keys-empty",
				className: "rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted",
				children: "No wallet keys yet. Add one with the button above, or generate one per agent from the Agents page."
			}) : (0, import_jsx_runtime.jsx)("ul", {
				"data-testid": "wallet-keys-list",
				className: "space-y-1 rounded-md border border-border/40 bg-card/30 p-1",
				children: entries.map((entry) => {
					const revealed = revealMap[entry.key];
					const loading = revealLoading[entry.key];
					const address = revealed ? tryExtractAgentAddress(revealed) : null;
					return (0, import_jsx_runtime.jsxs)("li", {
						className: "flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg-muted/30",
						children: [
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [(0, import_jsx_runtime.jsx)("p", {
									className: "truncate text-xs font-medium text-txt",
									children: entryDisplayLabel(entry)
								}), (0, import_jsx_runtime.jsx)("p", {
									className: "truncate font-mono text-2xs text-muted",
									children: revealed ? address ? `address: ${address}` : maskValue(revealed) : entry.key
								})]
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-txt",
								"aria-label": revealed ? `Hide ${entry.key}` : `Reveal ${entry.key}`,
								onClick: () => revealed ? onHide(entry.key) : void onReveal(entry.key),
								disabled: loading,
								"data-testid": `wallet-keys-reveal-${entry.key}`,
								children: loading ? (0, import_jsx_runtime.jsx)(Loader2, {
									className: "h-3.5 w-3.5 animate-spin",
									"aria-hidden": true
								}) : revealed ? (0, import_jsx_runtime.jsx)(EyeOff, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}) : (0, import_jsx_runtime.jsx)(Eye, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-danger",
								"aria-label": `Delete ${entry.key}`,
								onClick: () => void onDelete(entry),
								"data-testid": `wallet-keys-delete-${entry.key}`,
								children: (0, import_jsx_runtime.jsx)(Trash2, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								})
							})
						]
					}, entry.key);
				})
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/settings/IdentitySettingsSection.js
function resolveEditableVoiceSelectionKey(config) {
	const elevenLabsVoiceId = typeof config?.elevenlabs?.voiceId === "string" ? config.elevenlabs.voiceId.trim() : "";
	const edgeVoiceId = typeof config?.edge?.voice === "string" ? config.edge.voice.trim() : "";
	const provider = config?.provider ?? (edgeVoiceId && !elevenLabsVoiceId ? "edge" : "elevenlabs");
	return `${provider}:${provider === "edge" ? edgeVoiceId : elevenLabsVoiceId}`;
}
function resolveVisibleVoicePresetId(config, useElevenLabs) {
	if (useElevenLabs) {
		const elevenLabsVoiceId = typeof config.elevenlabs?.voiceId === "string" ? config.elevenlabs.voiceId.trim() : "";
		if (!elevenLabsVoiceId) return null;
		return PREMADE_VOICES.find((preset) => preset.voiceId === elevenLabsVoiceId)?.id ?? null;
	}
	const edgeVoiceId = typeof config.edge?.voice === "string" ? config.edge.voice.trim() : "";
	if (!edgeVoiceId) return null;
	return EDGE_BACKUP_VOICES.find((preset) => preset.voiceId === edgeVoiceId)?.id ?? null;
}
function normalizeVoiceConfigForSave(args) {
	if ((args.voiceConfig.provider ?? (args.useElevenLabs ? "elevenlabs" : "edge")) === "edge") return {
		...args.voiceConfig,
		provider: "edge",
		edge: args.voiceConfig.edge ?? {}
	};
	const hasElevenLabsApiKey = hasConfiguredApiKey(args.voiceConfig.elevenlabs?.apiKey);
	const defaultVoiceMode = typeof args.voiceConfig.mode === "string" ? args.voiceConfig.mode : args.useElevenLabs && !hasElevenLabsApiKey ? "cloud" : "own-key";
	const normalized = {
		...args.voiceConfig.elevenlabs ?? {},
		modelId: args.voiceConfig.elevenlabs?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL
	};
	const sanitizedKey = sanitizeApiKey(normalized.apiKey);
	if (sanitizedKey) normalized.apiKey = sanitizedKey;
	else delete normalized.apiKey;
	return {
		...args.voiceConfig,
		provider: "elevenlabs",
		mode: defaultVoiceMode,
		elevenlabs: normalized
	};
}
function IdentitySettingsSection() {
	const { setTimeout } = useTimeout();
	const { t, characterData, characterDraft, characterLoading, handleCharacterFieldInput, handleSaveCharacter, loadCharacter, elizaCloudConnected, elizaCloudVoiceProxyAvailable } = useApp();
	const useElevenLabs = elizaCloudConnected || elizaCloudVoiceProxyAvailable;
	const [voiceConfig, setVoiceConfig] = useState({});
	const [savedVoiceConfig, setSavedVoiceConfig] = useState({});
	const [voiceLoading, setVoiceLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveSuccess, setSaveSuccess] = useState(false);
	const [saveError, setSaveError] = useState(null);
	const [voiceTesting, setVoiceTesting] = useState(false);
	const audioRef = useRef(null);
	const attemptedInitialCharacterLoadRef = useRef(false);
	const hasCharacterDraft = Object.keys(characterDraft).length > 0;
	useEffect(() => {
		if (attemptedInitialCharacterLoadRef.current || characterLoading || characterData || hasCharacterDraft) return;
		attemptedInitialCharacterLoadRef.current = true;
		loadCharacter();
	}, [
		characterData,
		characterLoading,
		hasCharacterDraft,
		loadCharacter
	]);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			setVoiceLoading(true);
			try {
				const tts = ((await client.getConfig()).messages ?? {}).tts ?? {};
				if (!cancelled) {
					setVoiceConfig(tts);
					setSavedVoiceConfig(tts);
				}
			} catch {
				if (!cancelled) {
					setVoiceConfig({});
					setSavedVoiceConfig({});
				}
			} finally {
				if (!cancelled) setVoiceLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		return () => {
			if (!audioRef.current) return;
			audioRef.current.pause();
			audioRef.current.currentTime = 0;
			audioRef.current = null;
		};
	}, []);
	const stopVoicePreview = useCallback(() => {
		if (!audioRef.current) return;
		audioRef.current.pause();
		audioRef.current.currentTime = 0;
		audioRef.current = null;
		setVoiceTesting(false);
	}, []);
	const visibleVoicePresetId = useMemo(() => resolveVisibleVoicePresetId(voiceConfig, useElevenLabs), [useElevenLabs, voiceConfig]);
	const activeVoicePreset = useMemo(() => {
		return (useElevenLabs ? PREMADE_VOICES : EDGE_BACKUP_VOICES).find((preset) => preset.id === visibleVoicePresetId) ?? null;
	}, [useElevenLabs, visibleVoicePresetId]);
	const voiceGroups = useMemo(() => {
		if (useElevenLabs) return ELEVENLABS_VOICE_GROUPS.map((group) => ({
			label: t(group.labelKey, { defaultValue: group.defaultLabel }),
			items: group.items.map((item) => {
				const preset = PREMADE_VOICES.find((entry) => entry.id === item.id);
				return {
					id: item.id,
					text: preset?.nameKey ? t(preset.nameKey, { defaultValue: preset.name }) : preset?.name ?? item.text,
					hint: preset?.hintKey ? t(preset.hintKey, { defaultValue: preset.hint }) : preset?.hint
				};
			})
		}));
		return EDGE_VOICE_GROUPS.map((group) => ({
			label: t(group.labelKey, { defaultValue: group.defaultLabel }),
			items: group.items.map((item) => {
				const preset = EDGE_BACKUP_VOICES.find((entry) => entry.id === item.id);
				return {
					id: item.id,
					text: preset?.nameKey ? t(preset.nameKey, { defaultValue: preset.name }) : preset?.name ?? item.text,
					hint: preset?.hintKey ? t(preset.hintKey, { defaultValue: preset.hint }) : preset?.hint
				};
			})
		}));
	}, [t, useElevenLabs]);
	const savedName = typeof characterData?.name === "string" ? characterData.name : "";
	const savedSystem = typeof characterData?.system === "string" ? replaceNameTokens(characterData.system, savedName) : "";
	const draftName = typeof characterDraft.name === "string" ? characterDraft.name : "";
	const draftSystem = typeof characterDraft.system === "string" ? characterDraft.system : "";
	const characterDirty = draftName !== savedName || draftSystem !== savedSystem;
	const voiceDirty = resolveEditableVoiceSelectionKey(voiceConfig) !== resolveEditableVoiceSelectionKey(savedVoiceConfig);
	const dirty = characterDirty || voiceDirty;
	const showCharacterBootstrapping = !characterData && !hasCharacterDraft && (characterLoading || !attemptedInitialCharacterLoadRef.current);
	const handleVoiceSelect = useCallback((presetId) => {
		stopVoicePreview();
		if (useElevenLabs) {
			const preset = PREMADE_VOICES.find((entry) => entry.id === presetId);
			if (!preset) return;
			setVoiceConfig((prev) => {
				const existing = typeof prev.elevenlabs === "object" ? prev.elevenlabs : {};
				return {
					...prev,
					provider: "elevenlabs",
					elevenlabs: {
						...existing,
						voiceId: preset.voiceId
					}
				};
			});
			return;
		}
		const preset = EDGE_BACKUP_VOICES.find((entry) => entry.id === presetId);
		if (!preset) return;
		setVoiceConfig((prev) => {
			const existingEdge = typeof prev.edge === "object" ? prev.edge : {};
			return {
				...prev,
				provider: "edge",
				edge: {
					...existingEdge,
					voice: preset.voiceId
				}
			};
		});
	}, [stopVoicePreview, useElevenLabs]);
	const handlePreviewVoice = useCallback(() => {
		if (!activeVoicePreset?.previewUrl) return;
		stopVoicePreview();
		setVoiceTesting(true);
		const audio = new Audio(activeVoicePreset.previewUrl);
		audioRef.current = audio;
		audio.onended = () => {
			audioRef.current = null;
			setVoiceTesting(false);
		};
		audio.onerror = () => {
			audioRef.current = null;
			setVoiceTesting(false);
		};
		audio.play().catch(() => {
			audioRef.current = null;
			setVoiceTesting(false);
		});
	}, [activeVoicePreset, stopVoicePreview]);
	const handleSave = useCallback(async () => {
		if (!dirty) return;
		setSaving(true);
		setSaveError(null);
		setSaveSuccess(false);
		try {
			if (characterDirty) await handleSaveCharacter();
			if (voiceDirty) {
				const messages = (await client.getConfig()).messages ?? {};
				const normalizedVoiceConfig = normalizeVoiceConfigForSave({
					voiceConfig,
					useElevenLabs
				});
				await client.updateConfig({ messages: {
					...messages,
					tts: normalizedVoiceConfig
				} });
				dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, normalizedVoiceConfig);
				setSavedVoiceConfig(normalizedVoiceConfig);
			}
			setSaveSuccess(true);
			setTimeout(() => setSaveSuccess(false), 2500);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : t("settings.identity.saveFailed", { defaultValue: "Failed to save identity settings." }));
		} finally {
			setSaving(false);
		}
	}, [
		characterDirty,
		dirty,
		handleSaveCharacter,
		setTimeout,
		t,
		useElevenLabs,
		voiceConfig,
		voiceDirty
	]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-5",
		children: [
			showCharacterBootstrapping ? (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-2xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted shadow-sm",
				children: t("settings.identity.loading", { defaultValue: "Loading identity settings…" })
			}) : null,
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 lg:grid-cols-2",
				children: [(0, import_jsx_runtime.jsxs)(SettingsField, {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)(SettingsFieldLabel, {
						htmlFor: "settings-identity-name",
						children: t("common.name", { defaultValue: "Name" })
					}), (0, import_jsx_runtime.jsx)(Input, {
						id: "settings-identity-name",
						type: "text",
						value: draftName,
						placeholder: t("startupshell.AgentName", { defaultValue: "Agent name" }),
						onChange: (event) => handleCharacterFieldInput("name", event.target.value),
						className: "rounded-xl border-border/60 bg-card/80"
					})]
				}), (0, import_jsx_runtime.jsxs)(SettingsField, {
					className: "min-w-0",
					children: [(0, import_jsx_runtime.jsx)(SettingsFieldLabel, {
						id: "settings-identity-voice-label",
						children: t("common.voice", { defaultValue: "Voice" })
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)(ThemedSelect, {
							value: visibleVoicePresetId,
							groups: voiceGroups,
							onChange: handleVoiceSelect,
							placeholder: t("charactereditor.SelectAVoice", { defaultValue: "Select a voice" }),
							ariaLabelledBy: "settings-identity-voice-label",
							menuPlacement: "bottom",
							className: "min-w-0 flex-1",
							triggerClassName: "h-11 rounded-xl border-border/60 bg-card/80 px-3 text-sm shadow-none",
							menuClassName: "border-border/60 bg-bg/92 shadow-2xl backdrop-blur-md"
						}), (0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: voiceTesting ? "destructive" : "ghost",
							size: "icon",
							className: "h-10 w-10 shrink-0 rounded-full",
							onClick: voiceTesting ? stopVoicePreview : handlePreviewVoice,
							"aria-label": voiceTesting ? t("settings.identity.stopVoicePreview", { defaultValue: "Stop voice preview" }) : t("settings.identity.previewVoice", { defaultValue: "Preview voice" }),
							disabled: !activeVoicePreset?.previewUrl || voiceLoading,
							children: voiceTesting ? (0, import_jsx_runtime.jsx)(VolumeX, { className: "h-4 w-4" }) : (0, import_jsx_runtime.jsx)(Volume2, { className: "h-4 w-4" })
						})]
					})]
				})]
			}),
			(0, import_jsx_runtime.jsxs)(SettingsField, { children: [(0, import_jsx_runtime.jsx)(SettingsFieldLabel, {
				htmlFor: "settings-identity-system-prompt",
				children: t("settings.identity.systemPromptLabel", { defaultValue: "System prompt" })
			}), (0, import_jsx_runtime.jsx)(Textarea, {
				id: "settings-identity-system-prompt",
				value: draftSystem,
				rows: 10,
				maxLength: 1e5,
				placeholder: t("charactereditor.SystemPromptPlaceholder", { defaultValue: "Write in first person..." }),
				onChange: (event) => handleCharacterFieldInput("system", event.target.value),
				className: "min-h-[14rem] rounded-xl border-border/60 bg-card/80 font-mono text-xs leading-relaxed"
			})] }),
			(0, import_jsx_runtime.jsx)(SaveFooter, {
				dirty,
				saving,
				saveError,
				saveSuccess,
				onSave: () => void handleSave()
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/onboarding/reload-into-runtime-picker.js
/**
* Helper for the Settings ▸ Runtime panel "Switch runtime" action.
*
* Clears the persisted ElizaOS runtime selection (mobile-runtime-mode +
* active-server in localStorage), then navigates to the current URL with
* `?runtime=picker` appended. The query flag is consumed by
* `RuntimeGate.hasPickerOverride()` so the ElizaOS auto-local branch is
* bypassed and the chooser tiles render — the user can then pick Cloud /
* Remote / Local without the picker auto-completing back to local.
*
* This file is deliberately a leaf module with zero React or runtime
* dependencies so its contract can be tested without booting the
* SettingsView dependency graph (which transitively imports the API
* client and reads localStorage at module init).
*/
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";
const RUNTIME_PICKER_QUERY_NAME = "runtime";
const RUNTIME_PICKER_QUERY_VALUE = "picker";
function reloadIntoRuntimePicker() {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(MOBILE_RUNTIME_MODE_STORAGE_KEY);
		window.localStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
	} catch {}
	const url = new URL(window.location.href);
	url.searchParams.set(RUNTIME_PICKER_QUERY_NAME, RUNTIME_PICKER_QUERY_VALUE);
	window.location.href = url.toString();
}
const __TEST_ONLY__ = {
	ACTIVE_SERVER_STORAGE_KEY,
	MOBILE_RUNTIME_MODE_STORAGE_KEY
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/settings/RuntimeSettingsSection.js
/**
* Runtime Settings Section — only rendered on the ElizaOS variant.
*
* ElizaOS bypasses the RuntimeGate "Choose your setup" picker on first
* launch (the device IS the agent). This section is the deliberate
* escape hatch: it lets the user switch out of the default on-device
* agent into Eliza Cloud or a Remote Mac.
*
* The actual storage clear + URL navigation is in
* `onboarding/reload-into-runtime-picker.ts` — kept as a leaf module so
* its contract is testable without booting the SettingsView dependency
* graph.
*
* The vanilla Android APK never enters this section — `isElizaOS()` is
* false there, so users on a stock device pick their runtime through the
* regular picker flow on first launch and don't need this surface.
*/
function RuntimeSettingsSection() {
	const { t } = useApp();
	const handleSwitch = useCallback(() => {
		reloadIntoRuntimePicker();
	}, []);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-4 p-4 sm:p-5",
		children: [
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-sm text-foreground/80",
				children: t("settings.runtime.localActiveDescription", { defaultValue: "This device runs the on-device agent. Switch to Eliza Cloud or a Remote Mac to route the UI to a different agent." })
			}),
			(0, import_jsx_runtime.jsx)("div", { children: (0, import_jsx_runtime.jsx)(Button, {
				onClick: handleSwitch,
				variant: "default",
				size: "sm",
				children: t("settings.runtime.switchButton", { defaultValue: "Switch runtime…" })
			}) }),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-foreground/60",
				children: t("settings.runtime.switchNote", { defaultValue: "Switching reopens the runtime picker. Your current chat history stays on the device." })
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/SettingsView.js
var SettingsView_exports = /* @__PURE__ */ __exportAll({ SettingsView: () => SettingsView });
const SETTINGS_SIDEBAR_WIDTH_KEY = "eliza:settings:sidebar:width";
const SETTINGS_SIDEBAR_COLLAPSED_KEY = "eliza:settings:sidebar:collapsed";
const SETTINGS_SIDEBAR_DEFAULT_WIDTH = 240;
const SETTINGS_SIDEBAR_MIN_WIDTH = 200;
const SETTINGS_SIDEBAR_MAX_WIDTH = 520;
function clampSettingsSidebarWidth(value) {
	return Math.min(Math.max(value, SETTINGS_SIDEBAR_MIN_WIDTH), SETTINGS_SIDEBAR_MAX_WIDTH);
}
function readStoredSettingsSidebarWidth() {
	if (typeof window === "undefined") return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
	try {
		const raw = window.localStorage.getItem(SETTINGS_SIDEBAR_WIDTH_KEY);
		const parsed = raw ? Number.parseInt(raw, 10) : NaN;
		if (Number.isFinite(parsed)) return clampSettingsSidebarWidth(parsed);
	} catch {}
	return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
}
function readStoredSettingsSidebarCollapsed() {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(SETTINGS_SIDEBAR_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}
const SETTINGS_CONTENT_CLASS = "[scroll-padding-top:7rem] [scrollbar-gutter:stable] scroll-smooth bg-bg/10 pb-4 pt-2 sm:pb-6 sm:pt-3";
const SETTINGS_CONTENT_WIDTH_CLASS = "w-full min-h-0";
const SETTINGS_SECTION_STACK_CLASS = "space-y-3 pb-10 sm:space-y-4";
const SETTINGS_SECTIONS = [
	{
		id: "identity",
		label: "settings.sections.identity.label",
		defaultLabel: "Basics",
		icon: User,
		description: "settings.sections.identity.desc",
		defaultDescription: "Name, voice, and system prompt."
	},
	{
		id: "ai-model",
		label: "settings.sections.aimodel.label",
		defaultLabel: "Providers",
		icon: Brain,
		description: "settings.sections.aimodel.desc",
		defaultDescription: "Cloud, local, subscriptions, and direct providers."
	},
	{
		id: "runtime",
		label: "settings.sections.runtime.label",
		defaultLabel: "Runtime",
		icon: Server,
		description: "settings.sections.runtime.desc",
		defaultDescription: "Switch between the on-device agent, Eliza Cloud, and a Remote Mac."
	},
	{
		id: "appearance",
		label: "settings.sections.appearance.label",
		defaultLabel: "Appearance",
		icon: Palette,
		description: "settings.sections.appearance.desc",
		defaultDescription: "Language, theme, and content packs."
	},
	{
		id: "capabilities",
		label: "settings.sections.capabilities.label",
		defaultLabel: "Capabilities",
		icon: SlidersHorizontal,
		description: "settings.sections.capabilities.desc",
		defaultDescription: "Agent features and automation surfaces."
	},
	{
		id: "apps",
		label: "settings.sections.apps.label",
		defaultLabel: "Apps",
		icon: LayoutGrid,
		description: "settings.sections.apps.desc",
		defaultDescription: "Installed apps, launching, relaunching, editing, and creating new ones."
	},
	{
		id: "wallet-rpc",
		label: "settings.sections.walletrpc.label",
		defaultLabel: "Wallet & RPC",
		icon: Wallet,
		description: "settings.sections.walletrpc.desc",
		defaultDescription: "Wallet network and RPC providers."
	},
	{
		id: "permissions",
		label: "settings.sections.permissions.label",
		defaultLabel: "Permissions",
		icon: Shield,
		description: "settings.sections.permissions.desc",
		defaultDescription: "Browser and device access."
	},
	{
		id: "secrets",
		label: "settings.sections.secrets.label",
		defaultLabel: "Vault",
		icon: KeyRound,
		description: "settings.sections.secrets.desc",
		defaultDescription: "Backends, secrets, saved logins, and per-context routing."
	},
	{
		id: "security",
		label: "settings.sections.security.label",
		defaultLabel: "Security",
		icon: KeyRound,
		description: "settings.sections.security.desc",
		defaultDescription: "Local access, remote password, and sessions."
	},
	{
		id: "updates",
		label: "settings.sections.updates.label",
		defaultLabel: "Updates",
		icon: RefreshCw,
		description: "settings.sections.updates.desc",
		defaultDescription: "Software updates."
	},
	{
		id: "advanced",
		label: "settings.sections.backupReset.label",
		defaultLabel: "Backup & Reset",
		icon: Archive,
		description: "settings.sections.backupReset.desc",
		defaultDescription: "Export, import, and reset."
	}
];
function settingsSectionLabel(section, t) {
	return t(section.label, { defaultValue: section.defaultLabel });
}
function readSettingsHashSection() {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash.replace(/^#/, "");
	if (!hash) return null;
	if (hash === "cloud") return "ai-model";
	return SETTINGS_SECTIONS.some((section) => section.id === hash) ? hash : null;
}
function replaceSettingsHash(sectionId) {
	if (typeof window === "undefined") return;
	const nextHash = `#${sectionId}`;
	if (window.location.hash === nextHash) return;
	window.history.replaceState(null, "", nextHash);
}
const SettingsSection = forwardRef(function SettingsSection({ title, description, showDescription = false, bodyClassName, className, children, ...props }, ref) {
	const panelDescription = showDescription ? description : void 0;
	if (title || description) return (0, import_jsx_runtime.jsx)(PagePanel.CollapsibleSection, {
		ref,
		as: "section",
		expanded: true,
		variant: "section",
		heading: title ?? "",
		headingClassName: "text-base sm:text-lg font-semibold tracking-tight text-txt-strong",
		description: panelDescription,
		descriptionClassName: "mt-0.5 text-xs leading-snug text-muted",
		bodyClassName: cn("px-4 pb-3 pt-0 sm:px-5 sm:pb-4", bodyClassName),
		className: cn("rounded-2xl", className),
		...props,
		children
	});
	return (0, import_jsx_runtime.jsx)("section", {
		ref,
		"data-content-align-offset": 4,
		className,
		...props,
		children: (0, import_jsx_runtime.jsx)(PagePanel, {
			variant: "section",
			children: (0, import_jsx_runtime.jsx)("div", {
				className: cn("p-4 sm:p-5", bodyClassName),
				children
			})
		})
	});
});
function UpdatesSection() {
	return (0, import_jsx_runtime.jsx)(ReleaseCenterView, {});
}
function AdvancedSection() {
	const { t } = useApp();
	const { handleReset, exportBusy, exportPassword, exportIncludeLogs, exportError, exportSuccess, importBusy, importPassword, importFile, importError, importSuccess, handleAgentExport, handleAgentImport, setState } = useApp();
	const [exportModalOpen, setExportModalOpen] = useState(false);
	const [importModalOpen, setImportModalOpen] = useState(false);
	const importFileInputRef = useRef(null);
	const resetExportState = useCallback(() => {
		setState("exportPassword", "");
		setState("exportIncludeLogs", false);
		setState("exportError", null);
		setState("exportSuccess", null);
	}, [setState]);
	const resetImportState = useCallback(() => {
		if (importFileInputRef.current) importFileInputRef.current.value = "";
		setState("importPassword", "");
		setState("importFile", null);
		setState("importError", null);
		setState("importSuccess", null);
	}, [setState]);
	const openExportModal = useCallback(() => {
		resetExportState();
		setExportModalOpen(true);
	}, [resetExportState]);
	const closeExportModal = useCallback(() => {
		setExportModalOpen(false);
		resetExportState();
	}, [resetExportState]);
	const openImportModal = useCallback(() => {
		resetImportState();
		setImportModalOpen(true);
	}, [resetImportState]);
	const closeImportModal = useCallback(() => {
		setImportModalOpen(false);
		resetImportState();
	}, [resetImportState]);
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-6",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "grid grid-cols-1 sm:grid-cols-2 gap-4",
				children: [(0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					type: "button",
					onClick: openExportModal,
					className: "min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)_+_2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]",
					"aria-haspopup": "dialog",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg-accent p-3 shadow-sm transition-all group-hover:border-accent group-hover:bg-accent",
						children: (0, import_jsx_runtime.jsx)(Download, { className: "h-5 w-5 shrink-0 text-txt transition-colors group-hover:text-accent-fg" })
					}), (0, import_jsx_runtime.jsx)("div", { children: (0, import_jsx_runtime.jsx)("div", {
						className: "font-medium text-sm",
						children: t("settings.exportAgent")
					}) })]
				}), (0, import_jsx_runtime.jsxs)(Button, {
					variant: "outline",
					type: "button",
					onClick: openImportModal,
					className: "min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)_+_2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]",
					"aria-haspopup": "dialog",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg-accent p-3 shadow-sm transition-all group-hover:border-accent group-hover:bg-accent",
						children: (0, import_jsx_runtime.jsx)(Upload, { className: "h-5 w-5 shrink-0 text-txt transition-colors group-hover:text-accent-fg" })
					}), (0, import_jsx_runtime.jsx)("div", { children: (0, import_jsx_runtime.jsx)("div", {
						className: "font-medium text-sm",
						children: t("settings.importAgent")
					}) })]
				})]
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "border border-danger/30 rounded-2xl overflow-hidden bg-bg/40 backdrop-blur-sm",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "bg-danger/10 px-5 py-3 border-b border-danger/20 flex items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(AlertTriangle, { className: "w-4 h-4 text-danger" }), (0, import_jsx_runtime.jsx)("span", {
						className: "font-bold text-sm text-danger tracking-wide uppercase",
						children: t("settings.dangerZone")
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "p-4 space-y-4",
					children: (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-between",
						children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("div", {
							className: "font-medium text-sm",
							children: t("settings.resetAgent")
						}), (0, import_jsx_runtime.jsx)("div", {
							className: "text-xs text-muted",
							children: t("settings.resetAgentHint")
						})] }), (0, import_jsx_runtime.jsx)(Button, {
							variant: "destructive",
							size: "sm",
							className: "rounded-xl shadow-sm whitespace-nowrap",
							onClick: () => {
								handleReset();
							},
							children: t("settings.resetEverything")
						})]
					})
				})]
			})]
		}),
		(0, import_jsx_runtime.jsx)(Dialog, {
			open: exportModalOpen,
			onOpenChange: (open) => {
				if (!open) closeExportModal();
			},
			children: (0, import_jsx_runtime.jsxs)(DialogContent, { children: [(0, import_jsx_runtime.jsx)(DialogHeader, { children: (0, import_jsx_runtime.jsx)(DialogTitle, { children: t("settings.exportAgent") }) }), (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-4",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-2",
						children: [
							(0, import_jsx_runtime.jsx)(Label, {
								htmlFor: "settings-export-password",
								className: "text-txt-strong",
								children: t("settingsview.Password")
							}),
							(0, import_jsx_runtime.jsx)(Input, {
								id: "settings-export-password",
								type: "password",
								value: exportPassword,
								onChange: (e) => setState("exportPassword", e.target.value),
								placeholder: t("settingsview.EnterExportPasswor"),
								className: "rounded-lg bg-bg"
							}),
							(0, import_jsx_runtime.jsxs)(Label, {
								className: "flex items-center gap-2 font-normal text-muted",
								children: [(0, import_jsx_runtime.jsx)(Checkbox, {
									checked: exportIncludeLogs,
									onCheckedChange: (checked) => setState("exportIncludeLogs", !!checked)
								}), t("settingsview.IncludeRecentLogs")]
							})
						]
					}),
					exportError && (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
						role: "alert",
						"aria-live": "assertive",
						children: exportError
					}),
					exportSuccess && (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok",
						role: "status",
						"aria-live": "polite",
						children: exportSuccess
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-end gap-2 pt-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]",
							onClick: closeExportModal,
							children: t("common.cancel")
						}), (0, import_jsx_runtime.jsxs)(Button, {
							variant: "default",
							size: "sm",
							className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]",
							disabled: exportBusy,
							onClick: () => void handleAgentExport(),
							children: [exportBusy && (0, import_jsx_runtime.jsx)(Spinner, { size: 16 }), t("common.export")]
						})]
					})
				]
			})] })
		}),
		(0, import_jsx_runtime.jsx)(Dialog, {
			open: importModalOpen,
			onOpenChange: (open) => {
				if (!open) closeImportModal();
			},
			children: (0, import_jsx_runtime.jsxs)(DialogContent, { children: [(0, import_jsx_runtime.jsx)(DialogHeader, { children: (0, import_jsx_runtime.jsx)(DialogTitle, { children: t("settings.importAgent") }) }), (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-4",
				children: [
					(0, import_jsx_runtime.jsx)("input", {
						ref: importFileInputRef,
						type: "file",
						className: "hidden",
						accept: ".eliza-agent,.agent,application/octet-stream",
						onChange: (e) => setState("importFile", e.target.files?.[0] ?? null)
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-2",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "text-sm font-medium text-txt-strong",
							children: t("settingsview.BackupFile")
						}), (0, import_jsx_runtime.jsxs)(Button, {
							variant: "outline",
							className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)] flex w-full items-center justify-between gap-3 text-left",
							onClick: () => importFileInputRef.current?.click(),
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "min-w-0 flex-1 truncate text-sm text-txt",
								children: importFile?.name ?? t("settingsview.ChooseAnExportedBack")
							}), (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 text-xs font-medium text-txt",
								children: importFile ? t("settings.change", { defaultValue: "Change" }) : t("settings.browse", { defaultValue: "Browse" })
							})]
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-2",
						children: [(0, import_jsx_runtime.jsx)(Label, {
							htmlFor: "settings-import-password",
							className: "text-txt-strong",
							children: t("settingsview.Password")
						}), (0, import_jsx_runtime.jsx)(Input, {
							id: "settings-import-password",
							type: "password",
							value: importPassword,
							onChange: (e) => setState("importPassword", e.target.value),
							placeholder: t("settingsview.EnterImportPasswor"),
							className: "rounded-lg bg-bg"
						})]
					}),
					importError && (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
						role: "alert",
						"aria-live": "assertive",
						children: importError
					}),
					importSuccess && (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok",
						role: "status",
						"aria-live": "polite",
						children: importSuccess
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-end gap-2 pt-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]",
							onClick: closeImportModal,
							children: t("common.cancel")
						}), (0, import_jsx_runtime.jsxs)(Button, {
							variant: "default",
							size: "sm",
							className: "min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]",
							disabled: importBusy,
							onClick: () => void handleAgentImport(),
							children: [importBusy && (0, import_jsx_runtime.jsx)(Spinner, { size: 16 }), t("settings.import")]
						})]
					})
				]
			})] })
		})
	] });
}
function SettingsView({ inModal, onClose: _onClose, initialSection } = {}) {
	const { t, loadPlugins, walletEnabled } = useApp();
	const [activeSection, setActiveSection] = useState(() => initialSection ?? readSettingsHashSection() ?? "identity");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(readStoredSettingsSidebarCollapsed);
	const [sidebarWidth, setSidebarWidth] = useState(readStoredSettingsSidebarWidth);
	const shellRef = useRef(null);
	const initialAlignmentPendingRef = useRef(true);
	const scrollSelectionSuppressionTimerRef = useRef(null);
	const handleSidebarCollapsedChange = useCallback((next) => {
		setSidebarCollapsed(next);
		try {
			window.localStorage.setItem(SETTINGS_SIDEBAR_COLLAPSED_KEY, String(next));
		} catch {}
	}, []);
	const handleSidebarWidthChange = useCallback((next) => {
		const clamped = clampSettingsSidebarWidth(next);
		setSidebarWidth(clamped);
		try {
			window.localStorage.setItem(SETTINGS_SIDEBAR_WIDTH_KEY, String(clamped));
		} catch {}
	}, []);
	const suppressScrollSelection = useCallback((durationMs = 700) => {
		if (typeof window === "undefined") return;
		initialAlignmentPendingRef.current = true;
		if (scrollSelectionSuppressionTimerRef.current != null) window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
		scrollSelectionSuppressionTimerRef.current = window.setTimeout(() => {
			initialAlignmentPendingRef.current = false;
			scrollSelectionSuppressionTimerRef.current = null;
		}, durationMs);
	}, []);
	useEffect(() => {
		return () => {
			if (typeof window !== "undefined" && scrollSelectionSuppressionTimerRef.current != null) window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
		};
	}, []);
	const visibleSections = useMemo(() => {
		const showRuntime = isElizaOS();
		return SETTINGS_SECTIONS.filter((section) => {
			if (section.id === "wallet-rpc" && walletEnabled === false) return false;
			if (section.id === "runtime" && !showRuntime) return false;
			return true;
		});
	}, [walletEnabled]);
	const visibleSectionIds = useMemo(() => new Set(visibleSections.map((section) => section.id)), [visibleSections]);
	const { contentContainerRef, queueContentAlignment, registerContentItem, registerSidebarItem } = useLinkedSidebarSelection({
		contentTopOffset: 24,
		enabled: visibleSections.length > 0,
		selectedId: visibleSectionIds.has(activeSection) ? activeSection : null,
		topAlignedId: visibleSections[0]?.id ?? null
	});
	const alignContentToSection = useCallback((sectionId) => {
		const root = contentContainerRef.current;
		const target = shellRef.current?.querySelector(`#${sectionId}`);
		if (!(root instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
		const rootRect = root.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		root.scrollTo({
			top: root.scrollTop + targetRect.top - rootRect.top - 24,
			behavior: "auto"
		});
		return true;
	}, [contentContainerRef]);
	const queueSectionAlignment = useCallback((sectionId) => {
		suppressScrollSelection();
		queueContentAlignment(sectionId);
		if (typeof window === "undefined") return;
		window.requestAnimationFrame(() => {
			if (!alignContentToSection(sectionId)) window.setTimeout(() => alignContentToSection(sectionId), 50);
		});
	}, [
		alignContentToSection,
		queueContentAlignment,
		suppressScrollSelection
	]);
	useEffect(() => {
		loadPlugins();
	}, [loadPlugins]);
	const flashTimerRef = useRef(null);
	useEffect(() => {
		function focusProvider(provider) {
			if (!provider) return;
			setActiveSection("integrations");
			queueContentAlignment("integrations");
			requestAnimationFrame(() => {
				const node = document.querySelector(`[data-connector="${CSS.escape(provider)}"]`);
				if (!node) return;
				node.scrollIntoView({
					behavior: "smooth",
					block: "start"
				});
				node.classList.add("connector-flash");
				if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
				flashTimerRef.current = setTimeout(() => {
					node.classList.remove("connector-flash");
					flashTimerRef.current = null;
				}, 1800);
			});
		}
		function handle(event) {
			const detail = event.detail;
			if (!detail?.provider) return;
			consumePendingFocusProvider();
			focusProvider(detail.provider);
		}
		const pending = consumePendingFocusProvider();
		if (pending) focusProvider(pending);
		window.addEventListener(SETTINGS_FOCUS_CONNECTOR_EVENT, handle);
		return () => {
			window.removeEventListener(SETTINGS_FOCUS_CONNECTOR_EVENT, handle);
			if (flashTimerRef.current !== null) {
				clearTimeout(flashTimerRef.current);
				flashTimerRef.current = null;
			}
		};
	}, [queueContentAlignment]);
	const handleSectionChange = useCallback((sectionId) => {
		setActiveSection(sectionId);
		replaceSettingsHash(sectionId);
		queueSectionAlignment(sectionId);
	}, [queueSectionAlignment]);
	useEffect(() => {
		if (visibleSections.length === 0) return;
		if (!visibleSectionIds.has(activeSection)) setActiveSection(visibleSections[0].id);
	}, [
		activeSection,
		visibleSectionIds,
		visibleSections
	]);
	useEffect(() => {
		if (!initialAlignmentPendingRef.current) return;
		if (!visibleSectionIds.has(activeSection)) return;
		queueSectionAlignment(activeSection);
	}, [
		activeSection,
		queueSectionAlignment,
		visibleSectionIds
	]);
	useEffect(() => {
		if (!initialSection) return;
		handleSectionChange(initialSection);
	}, [handleSectionChange, initialSection]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const handleHashChange = () => {
			const nextSection = readSettingsHashSection();
			if (!nextSection || !visibleSectionIds.has(nextSection)) return;
			handleSectionChange(nextSection);
		};
		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [handleSectionChange, visibleSectionIds]);
	useEffect(() => {
		const shell = shellRef.current;
		const root = contentContainerRef.current;
		if (!shell || !root) return;
		const handleScroll = () => {
			if (initialAlignmentPendingRef.current) return;
			const sections = visibleSections.map((section) => {
				const el = shell.querySelector(`#${section.id}`);
				return {
					id: section.id,
					el
				};
			}).filter((section) => section.el instanceof HTMLElement);
			if (sections.length === 0) return;
			const rootRect = root.getBoundingClientRect();
			const activeAnchorOffset = Math.min(320, Math.max(180, root.clientHeight * .35));
			let currentSection = sections[0].id;
			for (const { id, el } of sections) if (el.getBoundingClientRect().top - rootRect.top <= activeAnchorOffset) currentSection = id;
			setActiveSection((prev) => {
				if (prev === currentSection) return prev;
				replaceSettingsHash(currentSection);
				return currentSection;
			});
		};
		root.addEventListener("scroll", handleScroll, { passive: true });
		handleScroll();
		return () => root.removeEventListener("scroll", handleScroll);
	}, [contentContainerRef, visibleSections]);
	const activeSectionDef = visibleSections.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? visibleSections[0] ?? null;
	const settingsSidebar = (0, import_jsx_runtime.jsx)(AppPageSidebar, {
		testId: "settings-sidebar",
		collapsible: true,
		collapsed: sidebarCollapsed,
		onCollapsedChange: handleSidebarCollapsedChange,
		resizable: true,
		width: sidebarWidth,
		onWidthChange: handleSidebarWidthChange,
		minWidth: SETTINGS_SIDEBAR_MIN_WIDTH,
		maxWidth: SETTINGS_SIDEBAR_MAX_WIDTH,
		onCollapseRequest: () => handleSidebarCollapsedChange(true),
		contentIdentity: "settings",
		collapseButtonTestId: "settings-sidebar-collapse-toggle",
		expandButtonTestId: "settings-sidebar-expand-toggle",
		collapseButtonAriaLabel: "Collapse settings",
		expandButtonAriaLabel: "Expand settings",
		mobileTitle: t("nav.settings"),
		mobileMeta: activeSectionDef ? settingsSectionLabel(activeSectionDef, t) : void 0,
		children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, {
			className: "pt-0",
			children: (0, import_jsx_runtime.jsx)(SidebarPanel, { children: (0, import_jsx_runtime.jsx)("nav", {
				className: "space-y-1.5",
				"aria-label": t("nav.settings"),
				children: visibleSections.map((section) => {
					const isActive = activeSection === section.id;
					const Icon = section.icon;
					return (0, import_jsx_runtime.jsx)(SidebarContent.Item, {
						as: "div",
						active: isActive,
						className: "gap-2 py-2",
						ref: registerSidebarItem(section.id),
						children: (0, import_jsx_runtime.jsxs)(SidebarContent.ItemButton, {
							onClick: () => handleSectionChange(section.id),
							"aria-current": isActive ? "page" : void 0,
							className: "items-center gap-2.5",
							children: [(0, import_jsx_runtime.jsx)(SidebarContent.ItemIcon, {
								active: isActive,
								className: "mt-0 h-8 w-8 rounded-lg p-1.5",
								children: (0, import_jsx_runtime.jsx)(Icon, {
									className: "h-4 w-4",
									"aria-hidden": true
								})
							}), (0, import_jsx_runtime.jsx)(SidebarContent.ItemBody, { children: (0, import_jsx_runtime.jsx)(SidebarContent.ItemTitle, {
								className: cn("text-sm leading-5", isActive ? "font-semibold" : "font-medium"),
								children: settingsSectionLabel(section, t)
							}) })]
						})
					}, section.id);
				})
			}) })
		})
	});
	const sectionsContent = (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		visibleSectionIds.has("identity") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "identity",
			title: t("settings.sections.identity.label", { defaultValue: "Basics" }),
			description: t("settings.sections.identity.desc", { defaultValue: "Name, voice, and system prompt." }),
			ref: registerContentItem("identity"),
			children: (0, import_jsx_runtime.jsx)(IdentitySettingsSection, {})
		}),
		visibleSectionIds.has("ai-model") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "ai-model",
			title: t("common.providers", { defaultValue: "Providers" }),
			description: t("settings.sections.aimodel.desc", { defaultValue: "Cloud, local, subscriptions, and direct providers." }),
			ref: registerContentItem("ai-model"),
			children: (0, import_jsx_runtime.jsx)(ProviderSwitcher, {})
		}),
		visibleSectionIds.has("runtime") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "runtime",
			title: t("settings.sections.runtime.label", { defaultValue: "Runtime" }),
			description: t("settings.sections.runtime.desc", { defaultValue: "Switch between the on-device agent, Eliza Cloud, and a Remote Mac." }),
			ref: registerContentItem("runtime"),
			children: (0, import_jsx_runtime.jsx)(RuntimeSettingsSection, {})
		}),
		visibleSectionIds.has("appearance") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "appearance",
			title: t("settings.sections.appearance.label", { defaultValue: "Appearance" }),
			description: t("settings.sections.appearance.desc", { defaultValue: "Language, theme, and content packs." }),
			ref: registerContentItem("appearance"),
			children: (0, import_jsx_runtime.jsx)(AppearanceSettingsSection, {})
		}),
		visibleSectionIds.has("capabilities") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "capabilities",
			title: t("common.capabilities", { defaultValue: "Capabilities" }),
			description: t("settings.sections.capabilities.desc", { defaultValue: "Agent features and automation surfaces." }),
			ref: registerContentItem("capabilities"),
			children: (0, import_jsx_runtime.jsx)(CapabilitiesSection, {})
		}),
		visibleSectionIds.has("apps") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "apps",
			title: t("settings.sections.apps.label", { defaultValue: "Apps" }),
			description: t("settings.sections.apps.desc", { defaultValue: "Installed apps, launching, relaunching, editing, and creating new ones." }),
			ref: registerContentItem("apps"),
			children: (0, import_jsx_runtime.jsx)(AppsManagementSection, {})
		}),
		visibleSectionIds.has("wallet-rpc") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "wallet-rpc",
			title: t("settings.sections.walletrpc.label", { defaultValue: "Wallet & RPC" }),
			description: t("settings.sections.walletrpc.desc", { defaultValue: "Wallet network and RPC providers." }),
			bodyClassName: "p-4 sm:p-5",
			ref: registerContentItem("wallet-rpc"),
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-6",
				children: [(0, import_jsx_runtime.jsx)(WalletKeysSection, {}), (0, import_jsx_runtime.jsx)(ConfigPageView, { embedded: true })]
			})
		}),
		visibleSectionIds.has("permissions") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "permissions",
			title: t("common.permissions", { defaultValue: "Permissions" }),
			description: t("settings.sections.permissions.desc", { defaultValue: "Browser and device access." }),
			ref: registerContentItem("permissions"),
			children: (0, import_jsx_runtime.jsx)(PermissionsSection, {})
		}),
		visibleSectionIds.has("secrets") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "secrets",
			title: t("settings.sections.secrets.label", { defaultValue: "Vault" }),
			description: t("settings.sections.secrets.desc", { defaultValue: "Backends, secrets, saved logins, and per-context routing." }),
			ref: registerContentItem("secrets"),
			children: (0, import_jsx_runtime.jsx)(SecretsManagerSection, {})
		}),
		visibleSectionIds.has("security") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "security",
			title: t("settings.sections.security.label", { defaultValue: "Security" }),
			description: t("settings.sections.security.desc", { defaultValue: "Local access, remote password, and sessions." }),
			ref: registerContentItem("security"),
			children: (0, import_jsx_runtime.jsx)(SecuritySettingsSection, {})
		}),
		visibleSectionIds.has("updates") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "updates",
			title: t("settings.sections.updates.label", { defaultValue: "Updates" }),
			description: t("settings.sections.updates.desc", { defaultValue: "Software updates." }),
			ref: registerContentItem("updates"),
			children: (0, import_jsx_runtime.jsx)(UpdatesSection, {})
		}),
		visibleSectionIds.has("advanced") && (0, import_jsx_runtime.jsx)(SettingsSection, {
			id: "advanced",
			title: t("settings.sections.backupReset.label", { defaultValue: "Backup & Reset" }),
			description: t("settings.sections.backupReset.desc", { defaultValue: "Export, import, and reset." }),
			ref: registerContentItem("advanced"),
			children: (0, import_jsx_runtime.jsx)(AdvancedSection, {})
		})
	] });
	return (0, import_jsx_runtime.jsx)(PageLayout, {
		className: cn("h-full", inModal && "min-h-0"),
		"data-testid": "settings-shell",
		sidebar: settingsSidebar,
		contentRef: contentContainerRef,
		contentClassName: SETTINGS_CONTENT_CLASS,
		contentInnerClassName: SETTINGS_CONTENT_WIDTH_CLASS,
		mobileSidebarLabel: activeSectionDef ? settingsSectionLabel(activeSectionDef, t) : t("nav.settings"),
		children: (0, import_jsx_runtime.jsx)("div", {
			ref: shellRef,
			className: `w-full ${SETTINGS_SECTION_STACK_CLASS}`,
			children: sectionsContent
		})
	});
}

//#endregion
export { LanguageDropdown as A, CloudDashboard as C, buildVoiceConfigForCharacterEntry as D, DEFAULT_ELEVEN_FAST_MODEL as E, useSecretsManagerShortcut as M, authLoginPassword as N, LANGUAGES as O, authMe as P, ReleaseCenterView as S, SecretsView as T, SETTINGS_REFRESH_DELAYS_MS as _, __TEST_ONLY__ as a, getPermissionBadge as b, SubscriptionStatus as c, PermissionsSection as d, CAPABILITIES as f, SETTINGS_PANEL_HEADER_CLASSNAME as g, SETTINGS_PANEL_CLASSNAME as h, RUNTIME_PICKER_QUERY_VALUE as i, SecretsManagerModalRoot as j, LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME as k, ApiKeyConfig as l, SETTINGS_PANEL_ACTIONS_CLASSNAME as m, SettingsView_exports as n, reloadIntoRuntimePicker as o, PERMISSION_BADGE_LABELS as p, RUNTIME_PICKER_QUERY_NAME as r, ProviderSwitcher as s, SettingsView as t, PermissionsOnboardingSection as u, SYSTEM_PERMISSIONS as v, ConfigPageView as w, translateWithFallback as x, getPermissionAction as y };