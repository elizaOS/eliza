import { D as require_jsx_runtime } from "./electrobun-runtime-zXJ9acDW.js";
import { N as getBootConfig, d as client, n as useApp } from "./useApp-Dh-r7aR7.js";
import { da as resolveAppAssetUrl, ua as resolveApiUrl } from "./state-BC9WO-N8.js";
import { createGeneratedAppHeroDataUrl, getAppHeroMonogram, getAppHeroThemeKey, getElizaCuratedAppCatalogOrder, isElizaCuratedAppName, normalizeElizaCuratedAppName, packageNameToAppRouteSlug } from "@elizaos/shared";
import { Badge, Button } from "@elizaos/ui";
import { Activity, AlertTriangle, BellRing, Bot, Briefcase, Check, CheckCheck, Copy, Eye, EyeOff, Gamepad2, Globe, Globe2, HeartPulse, ListMusic, ListTodo, MessageSquare, Music, OctagonAlert, Pause, Play, Plus, RefreshCw, Search, Sparkles, Square, SquareArrowOutUpRight, SquarePause, Trash2, Wallet, Workflow, Wrench, Zap } from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/overlay-app-registry.js
/**
* Overlay App Registry — simple registry for full-screen overlay apps.
*
* Apps register here at module scope. The host shell and apps catalog
* query the registry to discover and launch overlay apps.
*/
const OVERLAY_APP_REGISTRY_KEY = "__elizaosOverlayAppRegistry__";
const overlayRegistryGlobal = globalThis;
function getOverlayRegistry() {
	const existing = overlayRegistryGlobal[OVERLAY_APP_REGISTRY_KEY];
	if (existing) return existing;
	const next = /* @__PURE__ */ new Map();
	overlayRegistryGlobal[OVERLAY_APP_REGISTRY_KEY] = next;
	return next;
}
const registry = getOverlayRegistry();
/** Register an overlay app. Call at module scope. */
function registerOverlayApp(app) {
	registry.set(app.name, app);
}
/** Look up a registered overlay app by name. */
function getOverlayApp(name) {
	return registry.get(name);
}
/** Get all registered overlay apps. */
function getAllOverlayApps() {
	return Array.from(registry.values());
}
/**
* Get overlay apps that are available on the current platform. Filters
* out `androidOnly: true` apps when not running on Android. Used by the
* apps catalog UI so iOS / desktop / web users don't see tiles that
* launch into permanent error states.
*
* Platform detection: when `Capacitor.getPlatform()` is available it is
* preferred; otherwise the user-agent is inspected. Tests can pass a
* platform string explicitly.
*/
function getAvailableOverlayApps(platform = detectPlatformForCatalog()) {
	const isAndroid = platform === "android";
	return getAllOverlayApps().filter((app) => isAndroid || app.androidOnly !== true);
}
function detectPlatformForCatalog() {
	const fromCap = globalThis.Capacitor?.getPlatform?.();
	if (fromCap) return fromCap;
	if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) return "android";
	return "web";
}
/** Check if an app name belongs to a registered overlay app. */
function isOverlayApp(name) {
	return registry.has(name);
}
/** Convert an OverlayApp to a RegistryAppInfo for the apps catalog. */
function overlayAppToRegistryInfo(app) {
	return {
		name: app.name,
		displayName: app.displayName,
		description: app.description,
		category: app.category,
		launchType: "overlay",
		launchUrl: null,
		icon: app.icon,
		heroImage: app.heroImage ?? null,
		capabilities: [],
		stars: 0,
		repository: "",
		latestVersion: null,
		supports: {
			v0: false,
			v1: false,
			v2: true
		},
		npm: {
			package: app.name,
			v0Version: null,
			v1Version: null,
			v2Version: null
		}
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/character/MusicLibraryCharacterWidget.js
var import_jsx_runtime = require_jsx_runtime();
const MUSIC_LIBRARY_COMMANDS = [
	{
		icon: (0, import_jsx_runtime.jsx)(ListMusic, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		}),
		label: "Show saved playlists",
		prompt: "show my playlists"
	},
	{
		icon: (0, import_jsx_runtime.jsx)(Plus, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		}),
		label: "Save the current queue",
		prompt: "save this as a playlist"
	},
	{
		icon: (0, import_jsx_runtime.jsx)(Search, {
			className: "h-3.5 w-3.5",
			"aria-hidden": true
		}),
		label: "Find music",
		prompt: "search YouTube for music"
	}
];
function MusicLibraryCharacterWidget({ pluginState }) {
	if (pluginState?.enabled === false) return null;
	const pluginReady = pluginState?.isActive === true;
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "rounded-2xl border border-border/40 bg-bg/70 px-4 py-4",
		"data-testid": "character-widget-music-library",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "mb-3 flex items-center justify-between gap-3",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)(Music, {
					className: "h-4 w-4 shrink-0 text-accent",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("h2", {
					className: "truncate text-sm font-semibold text-txt",
					children: "Music Library"
				})]
			}), (0, import_jsx_runtime.jsx)("span", {
				className: `shrink-0 rounded-[var(--radius-sm)] border px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.12em] ${pluginReady ? "border-ok/30 bg-ok/10 text-ok" : "border-border/40 bg-bg-accent text-muted"}`,
				children: pluginReady ? "Active" : "Plugin"
			})]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "grid gap-2 sm:grid-cols-3",
			children: MUSIC_LIBRARY_COMMANDS.map((command) => (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 rounded-xl border border-border/35 bg-card/45 px-3 py-2",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "mb-1 flex items-center gap-1.5 text-xs font-medium text-txt",
					children: [(0, import_jsx_runtime.jsx)("span", {
						className: "text-muted",
						children: command.icon
					}), (0, import_jsx_runtime.jsx)("span", {
						className: "truncate",
						children: command.label
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "truncate font-mono text-3xs text-muted",
					children: command.prompt
				})]
			}, command.label))
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/app-identity.js
const APP_TILE_PALETTES = [
	["#0ea5e9", "#8b5cf6"],
	["#10b981", "#14b8a6"],
	["#f59e0b", "#f97316"],
	["#ef4444", "#f43f5e"],
	["#22c55e", "#84cc16"],
	["#06b6d4", "#3b82f6"],
	["#a855f7", "#ec4899"],
	["#64748b", "#0f766e"]
];
function hashString(value) {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) hash = hash * 31 + value.charCodeAt(index) | 0;
	return Math.abs(hash);
}
function iconImageSource(icon) {
	const value = icon?.trim();
	if (!value) return null;
	if (/^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i.test(value)) return resolveRuntimeImageUrl(value);
	return null;
}
/**
* Convert a heroImage/icon src into a runtime-safe URL.
*
* Root-relative paths fail under non-http origins (electrobun://, file://)
* because the page origin isn't the static asset host. Route them through
* the appropriate runtime resolver so they hit the API/asset base instead.
*/
function resolveRuntimeImageUrl(value) {
	if (/^(https?:|data:|blob:|file:|capacitor:|electrobun:|app:)/i.test(value)) return value;
	if (value.startsWith("/api/") || value.startsWith("api/")) return resolveApiUrl(value.startsWith("/") ? value : `/${value}`);
	return resolveAppAssetUrl(value);
}
function getAppMonogram(app) {
	return getAppHeroMonogram(app);
}
function getAppPalette(name) {
	return APP_TILE_PALETTES[hashString(name) % APP_TILE_PALETTES.length];
}
function getAppCategoryIcon(app) {
	switch (getAppHeroThemeKey(app)) {
		case "play": return Gamepad2;
		case "chat": return Bot;
		case "money": return Wallet;
		case "tools": return Wrench;
		case "world": return Globe2;
		case "ops": return Briefcase;
		default: return Sparkles;
	}
}
function useResolvedAppImageSource(app) {
	const heroRaw = app.heroImage?.trim() || null;
	const heroSrc = heroRaw ? resolveRuntimeImageUrl(heroRaw) : null;
	const iconSrc = iconImageSource(app.icon);
	const generatedSrc = createGeneratedAppHeroDataUrl(app);
	const sourceKey = [
		app.name,
		app.displayName ?? "",
		app.category ?? "",
		app.description ?? "",
		heroSrc ?? "",
		iconSrc ?? ""
	].join("\0");
	const [failureState, setFailureState] = useState(() => ({
		sourceKey,
		failedHeroSrc: null,
		failedIconSrc: null,
		generatedFailed: false
	}));
	const currentFailureState = failureState.sourceKey === sourceKey ? failureState : {
		sourceKey,
		failedHeroSrc: null,
		failedIconSrc: null,
		generatedFailed: false
	};
	const imageSrc = heroSrc && heroSrc !== currentFailureState.failedHeroSrc ? heroSrc : iconSrc && iconSrc !== currentFailureState.failedIconSrc ? iconSrc : !currentFailureState.generatedFailed ? generatedSrc : null;
	const handleImageError = () => {
		if (imageSrc === heroSrc && heroSrc) {
			setFailureState({
				...currentFailureState,
				failedHeroSrc: heroSrc
			});
			return;
		}
		if (imageSrc === iconSrc && iconSrc) {
			setFailureState({
				...currentFailureState,
				failedIconSrc: iconSrc
			});
			return;
		}
		if (imageSrc === generatedSrc) setFailureState({
			...currentFailureState,
			generatedFailed: true
		});
	};
	return {
		imageSrc,
		handleImageError
	};
}
function AppIdentityTile({ app, active = false, className = "", size = "md", imageOnly = false }) {
	const palette = getAppPalette(app.name);
	const { imageSrc, handleImageError } = useResolvedAppImageSource(app);
	const Icon = getAppCategoryIcon(app);
	const monogram = getAppMonogram(app);
	const outerSize = size === "sm" ? "h-12 w-12 rounded-2xl" : "h-14 w-14 rounded-[1.15rem]";
	const iconSize = size === "sm" ? "h-5 w-5" : "h-6 w-6";
	const monoSize = size === "sm" ? "text-[0.64rem]" : "text-[0.68rem]";
	const badgeSize = size === "sm" ? "text-[0.56rem]" : "text-[0.58rem]";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `relative shrink-0 overflow-hidden border border-white/10 shadow-sm ring-1 ring-black/5 ${outerSize} ${className}`,
		style: { backgroundImage: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)` },
		"aria-hidden": true,
		children: [
			!imageOnly ? (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(255,255,255,0.32),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,255,255,0.18),transparent_26%),radial-gradient(circle_at_50%_100%,rgba(0,0,0,0.16),transparent_35%)]" }) : null,
			imageSrc ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("img", {
				src: imageSrc,
				alt: "",
				className: "absolute inset-0 h-full w-full object-cover",
				loading: "lazy",
				decoding: "async",
				onError: handleImageError
			}), !imageOnly ? (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-0 bg-black/10" }) : null] }) : (0, import_jsx_runtime.jsxs)("div", {
				className: "absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-white",
				children: [(0, import_jsx_runtime.jsx)(Icon, {
					className: iconSize,
					strokeWidth: 2.15
				}), (0, import_jsx_runtime.jsx)("span", {
					className: `inline-flex items-center rounded-full border border-white/20 bg-white/12 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-white ${monoSize}`,
					children: monogram
				})]
			}),
			active && !imageOnly ? (0, import_jsx_runtime.jsx)("span", { className: "absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border border-card bg-ok shadow-sm" }) : null,
			!imageOnly ? (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/12 to-transparent" }) : null,
			imageSrc && !imageOnly ? (0, import_jsx_runtime.jsx)("div", {
				className: `absolute left-1.5 top-1.5 inline-flex items-center rounded-full border border-white/20 bg-black/10 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-white ${badgeSize}`,
				children: monogram
			}) : null
		]
	});
}
function getHeroBlobs(seed) {
	const pick = (shift, mod) => (seed >> shift) % mod;
	return [
		{
			cx: 18 + pick(1, 32),
			cy: 22 + pick(3, 28),
			r: 34 + pick(5, 22),
			opacity: .32
		},
		{
			cx: 72 - pick(7, 26),
			cy: 68 - pick(9, 32),
			r: 38 + pick(11, 26),
			opacity: .24
		},
		{
			cx: 45 + pick(13, 24),
			cy: 40 + pick(15, 24),
			r: 24 + pick(17, 18),
			opacity: .18
		}
	];
}
function AppHero({ app, className = "", imageOnly = false }) {
	const palette = getAppPalette(app.name);
	const { imageSrc, handleImageError } = useResolvedAppImageSource(app);
	const Icon = getAppCategoryIcon(app);
	const blobs = getHeroBlobs(hashString(app.name));
	const iconRotation = hashString(app.name) % 24;
	const useImage = Boolean(imageSrc);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: `relative w-full overflow-hidden ${className}`,
		style: { backgroundImage: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)` },
		"aria-hidden": true,
		children: [useImage && imageSrc ? (0, import_jsx_runtime.jsx)("img", {
			src: imageSrc,
			alt: "",
			loading: "lazy",
			decoding: "async",
			className: "absolute inset-0 h-full w-full object-cover",
			onError: handleImageError
		}) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
			(0, import_jsx_runtime.jsxs)("svg", {
				className: "absolute inset-0 h-full w-full",
				viewBox: "0 0 100 100",
				preserveAspectRatio: "none",
				"aria-hidden": true,
				children: [(0, import_jsx_runtime.jsx)("title", { children: "Hero backdrop" }), blobs.map((blob) => (0, import_jsx_runtime.jsx)("circle", {
					cx: blob.cx,
					cy: blob.cy,
					r: blob.r,
					fill: "white",
					opacity: blob.opacity,
					style: { mixBlendMode: "soft-light" }
				}, `${blob.cx}-${blob.cy}-${blob.r}`))]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "absolute inset-0 opacity-[0.14]",
				style: {
					backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.85) 1px, transparent 1px)",
					backgroundSize: "14px 14px"
				}
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "pointer-events-none absolute -right-6 -bottom-8 h-[68%] w-[68%] text-white/[0.22]",
				style: { transform: `rotate(${iconRotation - 12}deg)` },
				children: (0, import_jsx_runtime.jsx)(Icon, {
					className: "h-full w-full",
					strokeWidth: 1.25
				})
			})
		] }), !imageOnly ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("div", { className: "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-20%,rgba(255,255,255,0.22),transparent_55%)]" }), (0, import_jsx_runtime.jsx)("div", { className: "pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/60 via-black/20 to-transparent" })] }) : null]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/internal-tool-apps.js
const INTERNAL_TOOL_APPS = [
	{
		name: "@elizaos/app-lifeops",
		displayName: "LifeOps",
		description: "Run tasks, reminders, calendar, inbox, and connected operational workflows.",
		heroImage: "/api/apps/hero/lifeops",
		targetTab: "lifeops",
		capabilities: [
			"lifeops",
			"tasks",
			"calendar",
			"gmail"
		],
		order: 0,
		windowPath: "/apps/lifeops"
	},
	{
		name: "@elizaos/app-plugin-viewer",
		displayName: "Plugin Viewer",
		description: "Inspect installed plugins, connectors, and runtime feature flags.",
		heroImage: "/app-heroes/plugin-viewer.png",
		targetTab: "plugins",
		capabilities: [
			"plugins",
			"connectors",
			"viewer"
		],
		order: 1,
		windowPath: "/apps/plugins"
	},
	{
		name: "@elizaos/app-skills-viewer",
		displayName: "Skills Viewer",
		description: "Create, enable, review, and install custom agent skills.",
		heroImage: "/app-heroes/skills-viewer.png",
		targetTab: "skills",
		capabilities: ["skills", "viewer"],
		order: 2,
		windowPath: "/apps/skills"
	},
	{
		name: "@elizaos/app-training",
		displayName: "Fine Tuning",
		description: "Build datasets, inspect trajectories, run training jobs, and activate tuned models.",
		heroImage: "/api/apps/hero/training",
		targetTab: "fine-tuning",
		capabilities: [
			"training",
			"fine-tuning",
			"datasets",
			"models"
		],
		order: 3,
		windowPath: "/apps/fine-tuning",
		hasDetailsPage: true
	},
	{
		name: "@elizaos/app-trajectory-viewer",
		displayName: "Trajectory Viewer",
		description: "Inspect LLM call history, prompts, and execution traces.",
		heroImage: "/app-heroes/trajectory-viewer.png",
		targetTab: "trajectories",
		capabilities: [
			"trajectories",
			"debug",
			"viewer"
		],
		order: 4,
		windowPath: "/apps/trajectories"
	},
	{
		name: "@elizaos/app-relationship-viewer",
		displayName: "Relationship Viewer",
		description: "Explore cross-channel people, identities, and relationship graphs.",
		heroImage: "/app-heroes/relationship-viewer.png",
		targetTab: "relationships",
		capabilities: [
			"relationships",
			"graph",
			"viewer"
		],
		order: 5,
		windowPath: "/apps/relationships"
	},
	{
		name: "@elizaos/app-memory-viewer",
		displayName: "Memory Viewer",
		description: "Browse memory, fact, and extraction activity.",
		heroImage: "/app-heroes/memory-viewer.png",
		targetTab: "memories",
		capabilities: [
			"memory",
			"facts",
			"viewer"
		],
		order: 6,
		windowPath: "/apps/memories"
	},
	{
		name: "@elizaos/app-steward",
		displayName: "Steward",
		description: "Review wallet approvals, transaction history, and signing execution status.",
		heroImage: "/api/apps/hero/steward",
		targetTab: "inventory",
		capabilities: [
			"wallet",
			"transactions",
			"approvals",
			"trading"
		],
		order: 7,
		windowPath: "/apps/inventory",
		hasDetailsPage: true
	},
	{
		name: "@elizaos/app-runtime-debugger",
		displayName: "Runtime Debugger",
		description: "Inspect runtime objects, plugin order, providers, and services.",
		heroImage: "/app-heroes/runtime-debugger.png",
		targetTab: "runtime",
		capabilities: [
			"runtime",
			"debug",
			"viewer"
		],
		order: 8,
		windowPath: "/apps/runtime"
	},
	{
		name: "@elizaos/app-database-viewer",
		displayName: "Database Viewer",
		description: "Inspect tables, media, vectors, and ad-hoc SQL.",
		heroImage: "/app-heroes/database-viewer.png",
		targetTab: "database",
		capabilities: [
			"database",
			"sql",
			"viewer"
		],
		order: 9,
		windowPath: "/apps/database"
	},
	{
		name: "@elizaos/app-elizamaker",
		displayName: "ElizaMaker",
		description: "Run drop, mint, whitelist, and verification workflows through the agent surfaces.",
		heroImage: "/api/apps/hero/elizamaker",
		targetTab: "chat",
		capabilities: [
			"drops",
			"minting",
			"whitelist",
			"verification"
		],
		order: 10,
		windowPath: "/apps/elizamaker",
		hasDetailsPage: true
	},
	{
		name: "@elizaos/app-log-viewer",
		displayName: "Log Viewer",
		description: "Search runtime and service logs.",
		heroImage: "/app-heroes/log-viewer.png",
		targetTab: "logs",
		capabilities: [
			"logs",
			"debug",
			"viewer"
		],
		order: 11,
		windowPath: "/apps/logs"
	}
];
const INTERNAL_TOOL_APP_BY_NAME = new Map(INTERNAL_TOOL_APPS.map((app) => [app.name, app]));
function getInternalToolApps() {
	return INTERNAL_TOOL_APPS.map((app) => ({
		name: app.name,
		displayName: app.displayName,
		description: app.description,
		category: "utility",
		launchType: "local",
		launchUrl: null,
		icon: null,
		heroImage: app.heroImage ?? null,
		capabilities: app.capabilities,
		stars: 0,
		repository: "",
		latestVersion: null,
		supports: {
			v0: false,
			v1: false,
			v2: true
		},
		npm: {
			package: app.name,
			v0Version: null,
			v1Version: null,
			v2Version: null
		}
	}));
}
function isInternalToolApp(name) {
	return INTERNAL_TOOL_APP_BY_NAME.has(name);
}
function getInternalToolAppTargetTab(name) {
	return INTERNAL_TOOL_APP_BY_NAME.get(name)?.targetTab ?? null;
}
function getInternalToolAppCatalogOrder(name) {
	return INTERNAL_TOOL_APP_BY_NAME.get(name)?.order ?? Number.MAX_SAFE_INTEGER;
}
function getInternalToolAppWindowPath(name) {
	return INTERNAL_TOOL_APP_BY_NAME.get(name)?.windowPath ?? null;
}
function getInternalToolAppHasDetailsPage(name) {
	return INTERNAL_TOOL_APP_BY_NAME.get(name)?.hasDetailsPage === true;
}
function getInternalToolAppDescriptors() {
	return INTERNAL_TOOL_APPS.map((app) => ({
		name: app.name,
		displayName: app.displayName,
		windowPath: app.windowPath ?? null,
		hasDetailsPage: app.hasDetailsPage === true,
		order: app.order
	}));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/helpers.js
const APP_CATALOG_SECTION_LABELS = {
	featured: "Featured",
	favorites: "Starred",
	games: "Games & Entertainment",
	developerUtilities: "Developer Utilities",
	finance: "Finance",
	other: "Other"
};
const APPS_VIEW_HIDDEN_APP_NAMES = [
	"@elizaos/app",
	"@elizaos/browser-bridge-extension",
	"app-counter",
	"@elizaos/app-browser",
	"@elizaos/app-form",
	"@elizaos/app-knowledge",
	"@elizaos/app-screenshare",
	"@elizaos/app-task-coordinator",
	"@elizaos/app-contacts",
	"@elizaos/app-phone",
	"@elizaos/app-wifi"
];
const APPS_VIEW_HIDDEN_APP_NAME_SET = new Set(APPS_VIEW_HIDDEN_APP_NAMES);
const FEATURED_APP_NAMES = new Set([
	"@elizaos/app-lifeops",
	"@elizaos/app-companion",
	"@elizaos/app-defense-of-the-agents",
	"@clawville/app-clawville"
]);
const DEFAULT_VISIBLE_GAME_APP_NAMES = new Set([
	"@elizaos/app-companion",
	"@elizaos/app-defense-of-the-agents",
	"@clawville/app-clawville"
]);
const DEFAULT_HIDDEN_APP_NAMES = new Set([
	"@elizaos/app-elizamaker",
	"@elizaos/app-hyperliquid",
	"@elizaos/app-polymarket",
	"@elizaos/app-shopify",
	"@elizaos/app-steward",
	"@elizaos/app-vincent"
]);
const WALLET_SCOPED_APP_NAMES = new Set([
	"@elizaos/app-hyperliquid",
	"@elizaos/app-polymarket",
	"@elizaos/app-vincent"
]);
const APP_CATALOG_SECTION_ORDER = [
	"featured",
	"favorites",
	"games",
	"finance",
	"developerUtilities",
	"other"
];
function getConfiguredDefaultAppNames() {
	return new Set((getBootConfig().defaultApps ?? []).filter((name) => typeof name === "string" && name.length > 0));
}
function isFeaturedAppName(name) {
	return FEATURED_APP_NAMES.has(name) || getConfiguredDefaultAppNames().has(name);
}
function parseBooleanEnvValue(value) {
	const normalized = String(value ?? "").trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function shouldShowAllApps(showAllApps) {
	if (typeof showAllApps === "boolean") return showAllApps;
	return parseBooleanEnvValue(import.meta.env.VITE_PUBLIC_SHOW_ALL_APPS);
}
function isHiddenFromAppsView(appName) {
	return APPS_VIEW_HIDDEN_APP_NAME_SET.has(appName);
}
function isCuratedGameApp(app) {
	app.category;
	return isElizaCuratedAppName(app.name);
}
function shouldShowAppInAppsView(app, options = {}) {
	const { isProd = typeof import.meta.env.PROD === "boolean" ? import.meta.env.PROD : Boolean(import.meta.env.PROD), showAllApps, walletEnabled = false } = options;
	if (isHiddenFromAppsView(app.name)) return false;
	const configuredDefaultAppNames = getConfiguredDefaultAppNames();
	if (!configuredDefaultAppNames.has(app.name) && !isInternalToolApp(app.name) && !isCuratedGameApp(app)) return false;
	if (shouldShowAllApps(showAllApps)) return true;
	const canonicalName = isInternalToolApp(app.name) ? app.name : normalizeElizaCuratedAppName(app.name) ?? app.name;
	const sectionKey = getAppCatalogSectionKey({
		name: app.name,
		category: app.category,
		displayName: "",
		description: ""
	});
	if (DEFAULT_HIDDEN_APP_NAMES.has(canonicalName) && !(walletEnabled && WALLET_SCOPED_APP_NAMES.has(canonicalName)) && !configuredDefaultAppNames.has(app.name) && !configuredDefaultAppNames.has(canonicalName)) return false;
	if (sectionKey === "games") return DEFAULT_VISIBLE_GAME_APP_NAMES.has(canonicalName) || configuredDefaultAppNames.has(app.name) || configuredDefaultAppNames.has(canonicalName);
	return true;
}
function filterAppsForCatalog(apps, { activeAppNames = /* @__PURE__ */ new Set(), isProd, searchQuery = "", showAllApps, showActiveOnly = false, walletEnabled } = {}) {
	const normalizedSearch = searchQuery.trim().toLowerCase();
	const seenCanonicalNames = /* @__PURE__ */ new Set();
	return [...apps].sort((left, right) => {
		const toolOrderDiff = getInternalToolAppCatalogOrder(left.name) - getInternalToolAppCatalogOrder(right.name);
		if (toolOrderDiff !== 0) return toolOrderDiff;
		const orderDiff = getElizaCuratedAppCatalogOrder(left.name) - getElizaCuratedAppCatalogOrder(right.name);
		if (orderDiff !== 0) return orderDiff;
		const leftCanonicalName = normalizeElizaCuratedAppName(left.name);
		const rightCanonicalName = normalizeElizaCuratedAppName(right.name);
		const leftCanonicalPenalty = left.name === leftCanonicalName ? 0 : 1;
		const rightCanonicalPenalty = right.name === rightCanonicalName ? 0 : 1;
		if (leftCanonicalPenalty !== rightCanonicalPenalty) return leftCanonicalPenalty - rightCanonicalPenalty;
		return (right.stars ?? 0) - (left.stars ?? 0);
	}).filter((app) => {
		if (!shouldShowAppInAppsView(app, {
			isProd,
			showAllApps,
			walletEnabled
		})) return false;
		const sectionLabel = getAppCatalogSectionLabel(app).toLowerCase();
		if (normalizedSearch && !app.name.toLowerCase().includes(normalizedSearch) && !(app.displayName ?? "").toLowerCase().includes(normalizedSearch) && !(app.description ?? "").toLowerCase().includes(normalizedSearch) && !(app.category ?? "").toLowerCase().includes(normalizedSearch) && !sectionLabel.includes(normalizedSearch)) return false;
		if (showActiveOnly && !activeAppNames.has(app.name)) return false;
		const canonicalName = isInternalToolApp(app.name) ? app.name : normalizeElizaCuratedAppName(app.name) ?? app.name;
		if (seenCanonicalNames.has(canonicalName)) return false;
		seenCanonicalNames.add(canonicalName);
		return true;
	});
}
function getAppCatalogSectionKey(app) {
	if (isFeaturedAppName(app.name)) return "featured";
	if (app.name === "@elizaos/app-steward" || app.name === "@elizaos/app-elizamaker") return "finance";
	if (isInternalToolApp(app.name)) return "developerUtilities";
	switch (normalizeElizaCuratedAppName(app.name) ?? app.name) {
		case "@elizaos/app-companion": return "games";
		case "@elizaos/app-vincent":
		case "@elizaos/app-shopify":
		case "@elizaos/app-hyperliquid":
		case "@elizaos/app-polymarket": return "finance";
		case "@elizaos/app-babylon": return "games";
		case "@hyperscape/plugin-hyperscape":
		case "@elizaos/app-2004scape":
		case "@elizaos/app-scape":
		case "@elizaos/app-defense-of-the-agents":
		case "@clawville/app-clawville": return "games";
	}
	const normalizedCategory = app.category.trim().toLowerCase();
	if (normalizedCategory === "game") return "games";
	if (normalizedCategory === "utility") return "developerUtilities";
	if (normalizedCategory === "social" || normalizedCategory === "world") return "games";
	if (normalizedCategory === "platform") return "finance";
	const searchBlob = [
		app.name,
		app.displayName ?? "",
		app.description ?? "",
		app.category
	].join(" ").toLowerCase();
	if (/companion|avatar|assistant|friend|chat|social/.test(searchBlob)) return "games";
	if (/commerce|shop|store|finance|wallet|market|trade|sales|business|team/.test(searchBlob)) return "finance";
	if (/debug|viewer|plugin|skill|memory|trajectory|runtime|database|log|sql/.test(searchBlob)) return "developerUtilities";
	return "other";
}
function getAppCatalogSectionLabel(app) {
	return APP_CATALOG_SECTION_LABELS[getAppCatalogSectionKey(app)];
}
function groupAppsForCatalog(apps, { favoriteAppNames = /* @__PURE__ */ new Set() } = {}) {
	const sections = [];
	const groupedApps = /* @__PURE__ */ new Map();
	const surfacedAppNames = /* @__PURE__ */ new Set();
	const favoriteApps = apps.filter((app) => favoriteAppNames.has(app.name));
	if (favoriteApps.length > 0) {
		sections.push({
			key: "favorites",
			label: APP_CATALOG_SECTION_LABELS.favorites,
			apps: favoriteApps
		});
		for (const app of favoriteApps) surfacedAppNames.add(app.name);
	}
	const featuredApps = apps.filter((app) => isFeaturedAppName(app.name) && !favoriteAppNames.has(app.name));
	if (featuredApps.length > 0) {
		sections.push({
			key: "featured",
			label: APP_CATALOG_SECTION_LABELS.featured,
			apps: featuredApps
		});
		for (const app of featuredApps) surfacedAppNames.add(app.name);
	}
	for (const app of apps) {
		if (surfacedAppNames.has(app.name)) continue;
		const sectionKey = getAppCatalogSectionKey(app);
		const sectionApps = groupedApps.get(sectionKey) ?? [];
		sectionApps.push(app);
		groupedApps.set(sectionKey, sectionApps);
	}
	return [...sections, ...APP_CATALOG_SECTION_ORDER.flatMap((key) => {
		if (key === "featured" || key === "favorites") return [];
		const sectionApps = groupedApps.get(key) ?? [];
		if (sectionApps.length === 0) return [];
		return [{
			key,
			label: APP_CATALOG_SECTION_LABELS[key],
			apps: sectionApps
		}];
	})];
}
function getAppShortName(app) {
	const clean = (app.displayName ?? app.name).replace(/^@[^/]+\/app-/, "");
	return clean.charAt(0).toUpperCase() + clean.slice(1);
}
/**
* Derive a URL slug from an app's package name.
*
* Uses the existing `packageNameToAppRouteSlug` for scoped packages
* (`@scope/app-foo` → `foo`, `@scope/plugin-bar` → `bar`).
* Falls back to a sanitised form of the raw name.
*/
function getAppSlug(appName) {
	const slug = packageNameToAppRouteSlug(appName);
	if (slug) return slug;
	return appName.replace(/^@[^/]+\//, "").replace(/^(app|plugin)-/, "").replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || appName;
}
/** Find an app by its URL slug. */
function findAppBySlug(apps, slug) {
	const normalizedSlug = slug.toLowerCase();
	return apps.find((app) => getAppSlug(app.name).toLowerCase() === normalizedSlug);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/catalog-loader.js
async function loadMergedCatalogApps({ includeHiddenApps = false } = {}) {
	const [catalogAppsResult, installedAppsResult] = await Promise.allSettled([client.listCatalogApps(), client.listApps()]);
	const catalogApps = catalogAppsResult.status === "fulfilled" ? catalogAppsResult.value : [];
	const installedApps = installedAppsResult.status === "fulfilled" ? installedAppsResult.value : [];
	const staticApps = [...getInternalToolApps(), ...catalogApps];
	const overlayApps = getAvailableOverlayApps().filter((app) => !staticApps.some((candidate) => candidate.name === app.name)).filter((app) => !installedApps.some((candidate) => candidate.name === app.name)).map(overlayAppToRegistryInfo);
	const seenNames = /* @__PURE__ */ new Set();
	const mergedApps = [
		...staticApps,
		...overlayApps,
		...installedApps
	].filter((app) => {
		if (seenNames.has(app.name)) return false;
		seenNames.add(app.name);
		return true;
	});
	return includeHiddenApps ? mergedApps : mergedApps.filter((app) => !isHiddenFromAppsView(app.name));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/run-attention.js
const HEARTBEAT_STALE_MS = 120 * 1e3;
const DOWN_STATUS_PATTERNS = [
	"disconnected",
	"failed",
	"error",
	"stale",
	"stopping",
	"stopped",
	"paused",
	"blocked",
	"offline",
	"lost",
	"missing",
	"unavailable"
];
const SESSION_READY_STATUSES = new Set([
	"running",
	"active",
	"connected",
	"ready",
	"playing",
	"live",
	"monitoring",
	"steering",
	"attached",
	"idle"
]);
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isDownSessionStatus(status) {
	const normalized = status.trim().toLowerCase();
	return DOWN_STATUS_PATTERNS.some((pattern) => normalized.includes(pattern));
}
function isReadySessionStatus(status) {
	return SESSION_READY_STATUSES.has(status.trim().toLowerCase());
}
function getRunAttentionReasons(run, now = Date.now()) {
	const reasons = [];
	const heartbeatAt = run.lastHeartbeatAt ? new Date(run.lastHeartbeatAt).getTime() : null;
	if (run.health.state === "offline") reasons.push("Run is offline");
	else if (run.health.state === "degraded") reasons.push(run.health.message ?? "Run health is degraded");
	if (run.viewerAttachment === "detached") reasons.push("Viewer is detached");
	else if (run.viewerAttachment === "unavailable") reasons.push("No viewer surface is available");
	if (!run.viewer?.url && run.viewerAttachment !== "unavailable") reasons.push("Viewer URL is missing");
	if (run.session?.canSendCommands === false) reasons.push("Command bridge is unavailable");
	if (isNonEmptyString(run.session?.status) && isDownSessionStatus(run.session.status) && !isReadySessionStatus(run.session.status)) reasons.push(`Session status is ${run.session.status}`);
	if (heartbeatAt === null) reasons.push("No heartbeat recorded");
	else if (Number.isFinite(heartbeatAt) && now - heartbeatAt > HEARTBEAT_STALE_MS) reasons.push("Heartbeat is stale");
	if (!run.supportsBackground && run.viewerAttachment !== "attached") reasons.push("Run may pause when the viewer is detached");
	return Array.from(new Set(reasons));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/shared.js
function WidgetSection({ title, icon, action, children, testId, onTitleClick }) {
	const titleContent = (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("span", {
		className: "inline-flex shrink-0 items-center justify-center text-muted [&>svg]:h-3.5 [&>svg]:w-3.5",
		children: icon
	}), (0, import_jsx_runtime.jsx)("span", {
		className: "truncate text-[11px] leading-none font-semibold uppercase tracking-[0.16em] text-muted",
		children: title
	})] });
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": testId,
		className: "space-y-1",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between gap-2 pr-1",
			children: [onTitleClick ? (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: onTitleClick,
				className: "inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-0.5 py-1 text-left transition-colors hover:text-txt",
				children: titleContent
			}) : (0, import_jsx_runtime.jsx)("div", {
				className: "flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1",
				children: titleContent
			}), action]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "px-3 text-xs",
			children
		})]
	});
}
function EmptyWidgetState({ icon, title, description, children }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col items-center justify-center gap-2 py-5 text-center",
			children: [
				(0, import_jsx_runtime.jsx)("span", {
					className: "text-muted/50",
					children: icon
				}),
				(0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs text-muted",
					children: title
				}),
				description ? (0, import_jsx_runtime.jsx)("p", {
					className: "text-3xs text-muted/70",
					children: description
				}) : null
			]
		}), children]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/agent-orchestrator.js
/**
* Chat-sidebar widgets for the `agent-orchestrator` plugin (Apps / Tasks /
* Activity). This file lives in `@elizaos/app-core` (not in
* `@elizaos/plugin-agent-orchestrator`) because the widget depends on app-core
* internals that the runtime plugin does not own and does not re-export:
* the app-core API client, `AppRunSummary` / `ActivityEvent` types, the
* `useApp` store, `TranslateFn`, `getRunAttentionReasons`, and the widget
* registry contract (`ChatSidebarWidgetDefinition` / `ChatSidebarWidgetProps`
* and the `EmptyWidgetState` / `WidgetSection` primitives).
*
* The runtime plugin is a pure Node package (actions, providers, services,
* api, types) with no React build target or widget-publication mechanism.
* Moving this file into the plugin would require standing up a React build,
* publishing app-core internals, and adding a widget-registration hook — a
* reverse coupling we don't want. The widget is owned by the app shell; the
* plugin just provides the backend capabilities it consumes.
*/
function relativeTime(ts) {
	const delta = Math.max(0, Math.floor((Date.now() - ts) / 1e3));
	if (delta < 5) return "just now";
	if (delta < 60) return `${delta}s ago`;
	const mins = Math.floor(delta / 60);
	if (mins < 60) return `${mins}m ago`;
	return `${Math.floor(mins / 60)}h ago`;
}
function relativeDuration(ts) {
	const delta = Math.max(1, Math.floor((Date.now() - ts) / 1e3));
	if (delta < 60) return `${delta}s`;
	const mins = Math.floor(delta / 60);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
}
const DEFAULT_EVENT_TYPE_META = {
	icon: Activity,
	toneClass: "bg-muted/20 text-muted",
	label: "activity"
};
const EVENT_TYPE_META = {
	task_registered: {
		icon: Play,
		toneClass: "bg-ok/20 text-ok",
		label: "task started"
	},
	task_complete: {
		icon: Check,
		toneClass: "bg-ok/20 text-ok",
		label: "task complete"
	},
	stopped: {
		icon: Square,
		toneClass: "bg-muted/20 text-muted",
		label: "stopped"
	},
	tool_running: {
		icon: Wrench,
		toneClass: "bg-accent/20 text-accent",
		label: "tool running"
	},
	blocked: {
		icon: SquarePause,
		toneClass: "bg-warn/20 text-warn",
		label: "blocked"
	},
	blocked_auto_resolved: {
		icon: CheckCheck,
		toneClass: "bg-ok/20 text-ok",
		label: "auto resolved"
	},
	escalation: {
		icon: AlertTriangle,
		toneClass: "bg-warn/20 text-warn",
		label: "escalation"
	},
	error: {
		icon: OctagonAlert,
		toneClass: "bg-danger/20 text-danger",
		label: "error"
	},
	"proactive-message": {
		icon: MessageSquare,
		toneClass: "bg-accent/20 text-accent",
		label: "proactive message"
	},
	reminder: {
		icon: BellRing,
		toneClass: "bg-warn/20 text-warn",
		label: "reminder"
	},
	workflow: {
		icon: Workflow,
		toneClass: "bg-ok/20 text-ok",
		label: "workflow"
	},
	"check-in": {
		icon: HeartPulse,
		toneClass: "bg-accent/20 text-accent",
		label: "check in"
	},
	nudge: {
		icon: Zap,
		toneClass: "bg-accent/20 text-accent",
		label: "nudge"
	}
};
const fallbackTranslate$1 = (key, vars) => typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
function formatIsoTime(value) {
	if (!value) return "unknown";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "unknown";
	return relativeTime(date.getTime());
}
function ActivityItemsContent({ events }) {
	if (events.length === 0) return (0, import_jsx_runtime.jsx)(EmptyWidgetState, {
		icon: (0, import_jsx_runtime.jsx)(Activity, { className: "h-8 w-8" }),
		title: "No recent activity"
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex flex-col gap-0.5",
		children: events.map((event) => {
			const eventTypeMeta = EVENT_TYPE_META[event.eventType] ?? DEFAULT_EVENT_TYPE_META;
			const EventIcon = eventTypeMeta.icon;
			return (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-bg-hover/40",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "shrink-0 whitespace-nowrap pt-0.5 text-3xs font-medium tabular-nums text-muted",
						children: relativeDuration(event.timestamp)
					}),
					(0, import_jsx_runtime.jsxs)("span", {
						className: `inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md ${eventTypeMeta.toneClass}`,
						role: "img",
						title: eventTypeMeta.label,
						children: [(0, import_jsx_runtime.jsx)(EventIcon, { className: "h-2.5 w-2.5" }), (0, import_jsx_runtime.jsx)("span", {
							className: "sr-only",
							children: eventTypeMeta.label
						})]
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "min-w-0 flex-1 break-words pt-0.5 text-2xs leading-4 text-txt",
						children: event.summary
					})
				]
			}, event.id);
		})
	});
}
function getClientErrorMessage(error, fallback) {
	return error instanceof Error ? error.message : fallback;
}
function getAppRunIdentity(run, catalogAppsByName) {
	const catalogApp = catalogAppsByName.get(run.appName);
	return {
		name: run.appName,
		displayName: catalogApp?.displayName ?? run.displayName,
		description: catalogApp?.description ?? run.summary ?? null,
		category: catalogApp?.category ?? "utility",
		icon: catalogApp?.icon ?? null,
		heroImage: catalogApp?.heroImage ?? null
	};
}
function AppRunCard({ run, attentionReasons, app }) {
	const healthDot = run.health.state === "healthy" ? "bg-ok" : run.health.state === "degraded" ? "bg-warn" : "bg-danger";
	const ViewerIcon = run.viewerAttachment === "attached" ? Eye : EyeOff;
	return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-lg border border-border/50 bg-bg-accent/30 p-2",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start gap-2",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "w-20 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/10",
				children: (0, import_jsx_runtime.jsx)(AppHero, {
					app,
					className: "aspect-[5/4]",
					imageOnly: true
				})
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [
					(0, import_jsx_runtime.jsx)("div", {
						className: "truncate text-2xs font-semibold text-txt",
						children: run.displayName
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1 flex flex-wrap items-center gap-1.5 text-3xs text-muted",
						children: [
							(0, import_jsx_runtime.jsx)("span", {
								className: `inline-block h-1.5 w-1.5 rounded-full ${healthDot}`,
								role: "img",
								"aria-label": run.health.state,
								title: run.health.state
							}),
							(0, import_jsx_runtime.jsx)(ViewerIcon, {
								className: "h-3 w-3",
								"aria-label": run.viewerAttachment
							}),
							(0, import_jsx_runtime.jsx)("span", { children: formatIsoTime(run.lastHeartbeatAt ?? run.updatedAt) })
						]
					}),
					(0, import_jsx_runtime.jsx)("div", {
						className: "mt-1 line-clamp-2 text-3xs text-muted",
						children: run.summary || run.health.message || "Run active."
					}),
					attentionReasons.length > 0 ? (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1.5 flex items-center gap-1.5 text-3xs text-warn",
						children: [(0, import_jsx_runtime.jsx)(AlertTriangle, {
							className: "h-3 w-3 shrink-0",
							"aria-label": "Needs attention"
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "truncate",
							children: attentionReasons[0]
						})]
					}) : null
				]
			})]
		})
	});
}
function AppRunsWidget(_props) {
	const app = useApp();
	const appRuns = app?.appRuns;
	const setTab = app?.setTab ?? (() => void 0);
	const setState = app?.setState ?? (() => void 0);
	const t = app?.t ?? fallbackTranslate$1;
	const [catalogApps, setCatalogApps] = useState([]);
	const [runs, setRuns] = useState(() => Array.isArray(appRuns) ? appRuns : []);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const catalogAppsByName = useMemo(() => new Map(catalogApps.map((catalogApp) => [catalogApp.name, catalogApp])), [catalogApps]);
	const currentRun = runs.find((run) => run.viewerAttachment === "attached" && run.viewer) ?? null;
	const attachedCount = runs.filter((run) => run.viewerAttachment === "attached").length;
	const backgroundCount = runs.filter((run) => run.viewerAttachment !== "attached").length;
	const attentionMap = useMemo(() => new Map(runs.map((run) => [run.runId, getRunAttentionReasons(run)])), [runs]);
	const needsAttentionCount = useMemo(() => runs.filter((run) => (attentionMap.get(run.runId)?.length ?? 0) > 0).length, [attentionMap, runs]);
	const attentionRuns = runs.filter((run) => (attentionMap.get(run.runId)?.length ?? 0) > 0);
	const shouldHideWidget = !loading && runs.length === 0 && error === null;
	useEffect(() => {
		let cancelled = false;
		loadMergedCatalogApps({ includeHiddenApps: true }).then((apps) => {
			if (!cancelled) setCatalogApps(apps);
		}).catch(() => void 0);
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		const refreshRuns = async () => {
			try {
				const nextRuns = await client.listAppRuns();
				const nextRunsSafe = Array.isArray(nextRuns) ? nextRuns : [];
				if (cancelled) return;
				setError(null);
				startTransition(() => {
					setRuns(nextRunsSafe);
					setState("appRuns", nextRunsSafe);
				});
			} catch (refreshError) {
				if (cancelled) return;
				setError(getClientErrorMessage(refreshError, "Failed to load app runs."));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		refreshRuns();
		const timer = setInterval(() => {
			refreshRuns();
		}, 5e3);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [setState]);
	if (shouldHideWidget) return null;
	return (0, import_jsx_runtime.jsxs)(WidgetSection, {
		title: t("appsview.Running", { defaultValue: "Apps" }),
		icon: (0, import_jsx_runtime.jsx)(Activity, { className: "h-4 w-4" }),
		action: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-1",
			children: [currentRun ? (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "h-6 w-6 p-0",
				"aria-label": "Resume viewer",
				onClick: () => {
					setState("appRuns", runs);
					setState("activeGameRunId", currentRun.runId);
					setTab("apps");
					setState("appsSubTab", "games");
				},
				children: (0, import_jsx_runtime.jsx)(Play, { className: "h-3.5 w-3.5" })
			}) : null, (0, import_jsx_runtime.jsx)(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "h-6 w-6 p-0",
				"aria-label": "Open apps",
				onClick: () => {
					setState("appRuns", runs);
					setTab("apps");
					setState("appsSubTab", "running");
				},
				children: (0, import_jsx_runtime.jsx)(SquareArrowOutUpRight, { className: "h-3.5 w-3.5" })
			})]
		}),
		testId: "chat-widget-app-runs",
		children: [error ? (0, import_jsx_runtime.jsx)("div", {
			className: "mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs-tight text-danger",
			children: error
		}) : null, runs.length === 0 ? loading ? (0, import_jsx_runtime.jsx)("div", {
			className: "text-xs-tight text-muted",
			children: "Loading app runs..."
		}) : (0, import_jsx_runtime.jsx)(EmptyWidgetState, {
			icon: (0, import_jsx_runtime.jsx)(Activity, { className: "h-8 w-8" }),
			title: "No games are running"
		}) : (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-2",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-3 text-3xs text-muted",
					children: [
						(0, import_jsx_runtime.jsxs)("span", {
							className: "inline-flex items-center gap-1",
							title: "Currently playing",
							children: [(0, import_jsx_runtime.jsx)(Eye, { className: "h-3 w-3" }), attachedCount]
						}),
						(0, import_jsx_runtime.jsxs)("span", {
							className: "inline-flex items-center gap-1",
							title: "Background",
							children: [(0, import_jsx_runtime.jsx)(EyeOff, { className: "h-3 w-3" }), backgroundCount]
						}),
						(0, import_jsx_runtime.jsxs)("span", {
							className: `inline-flex items-center gap-1 ${needsAttentionCount > 0 ? "text-warn" : "text-ok"}`,
							title: "Needs attention",
							children: [(0, import_jsx_runtime.jsx)(AlertTriangle, { className: "h-3 w-3" }), needsAttentionCount]
						})
					]
				}),
				attentionRuns.length > 0 ? (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-lg border border-warn/30 bg-warn/10 p-2",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "mb-1.5 flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-[0.08em] text-warn",
						children: [(0, import_jsx_runtime.jsx)(AlertTriangle, { className: "h-3 w-3" }), "Recovery"]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "flex flex-col gap-2",
						children: attentionRuns.slice(0, 3).map((run) => {
							return (0, import_jsx_runtime.jsx)(AppRunCard, {
								run,
								attentionReasons: attentionMap.get(run.runId) ?? [],
								app: getAppRunIdentity(run, catalogAppsByName)
							}, run.runId);
						})
					})]
				}) : null,
				(0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-col gap-2",
					children: runs.slice(0, 4).map((run) => (0, import_jsx_runtime.jsx)(AppRunCard, {
						run,
						attentionReasons: attentionMap.get(run.runId) ?? [],
						app: getAppRunIdentity(run, catalogAppsByName)
					}, run.runId))
				})
			]
		})]
	});
}
function OrchestratorActivityWidget({ events, clearEvents }) {
	const t = useApp()?.t ?? fallbackTranslate$1;
	if (events.length === 0) return null;
	return (0, import_jsx_runtime.jsx)(WidgetSection, {
		title: t("taskseventspanel.Activity", { defaultValue: "Activity" }),
		icon: (0, import_jsx_runtime.jsx)(Activity, { className: "h-4 w-4" }),
		action: (0, import_jsx_runtime.jsx)(Button, {
			variant: "ghost",
			size: "sm",
			onClick: clearEvents,
			"aria-label": "Clear activity",
			className: "h-6 w-6 p-0 text-muted",
			children: (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3.5 w-3.5" })
		}),
		testId: "chat-widget-events",
		children: (0, import_jsx_runtime.jsx)(ActivityItemsContent, { events })
	});
}
const AGENT_ORCHESTRATOR_PLUGIN_WIDGETS = [{
	id: "agent-orchestrator.apps",
	pluginId: "agent-orchestrator",
	order: 150,
	defaultEnabled: true,
	Component: AppRunsWidget
}, {
	id: "agent-orchestrator.activity",
	pluginId: "agent-orchestrator",
	order: 300,
	defaultEnabled: true,
	Component: OrchestratorActivityWidget
}];

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/browser-status.js
/**
* Compact browser-workspace widget for the chat-sidebar.
*
* Polls the workspace snapshot and renders a compact list of open tabs with
* a status indicator per tab (visible / background). Returns null when no
* tabs are open — the widget keeps the right rail quiet until the user
* actually has browser state.
*
* Title-click opens /browser. Tab-click focuses that tab via the backend.
*/
const POLL_INTERVAL_MS = 4e3;
const MAX_TAB_ROWS = 8;
function tabLabel(tab) {
	const title = tab.title?.trim();
	if (title) return title;
	const url = tab.url?.trim();
	if (!url) return "New tab";
	try {
		return new URL(url).hostname.replace(/^www\./, "") || url;
	} catch {
		return url;
	}
}
function tabStatus(tab) {
	if (tab.visible) return {
		label: "Active",
		dotClass: "bg-accent",
		textClass: "text-txt"
	};
	return {
		label: "Background",
		dotClass: "bg-muted/50",
		textClass: "text-muted"
	};
}
function BrowserStatusSidebarWidget(_props) {
	const { setTab } = useApp();
	const [snapshot, setSnapshot] = useState(null);
	useEffect(() => {
		let cancelled = false;
		let timer = null;
		async function poll() {
			try {
				const next = await client.getBrowserWorkspace();
				if (cancelled) return;
				setSnapshot(next);
			} catch {} finally {
				if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
			}
		}
		poll();
		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, []);
	const tabs = snapshot?.tabs ?? [];
	if (tabs.length === 0) return null;
	const rows = tabs.slice(0, MAX_TAB_ROWS);
	function handleTabClick(tab) {
		(async () => {
			try {
				await client.showBrowserWorkspaceTab?.(tab.id);
			} catch {}
		})();
		setTab("browser");
	}
	return (0, import_jsx_runtime.jsx)(WidgetSection, {
		title: "Browser",
		icon: (0, import_jsx_runtime.jsx)(Globe, { className: "h-3.5 w-3.5" }),
		testId: "chat-widget-browser-status",
		onTitleClick: () => setTab("browser"),
		children: (0, import_jsx_runtime.jsx)("div", {
			className: "flex flex-col gap-0.5 pt-0.5",
			children: rows.map((tab) => {
				const label = tabLabel(tab);
				const status = tabStatus(tab);
				return (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => handleTabClick(tab),
					title: tab.url ?? label,
					"data-testid": `chat-widget-browser-tab-${tab.id}`,
					className: "flex items-center gap-2 rounded-[var(--radius-sm)] px-0.5 py-0.5 text-left transition-colors hover:bg-bg-hover/40",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: `h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`,
							"aria-hidden": true
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: `min-w-0 flex-1 truncate text-3xs ${status.textClass}`,
							children: label
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 text-3xs uppercase tracking-wider text-muted/70",
							children: status.label
						})
					]
				}, tab.id);
			})
		})
	});
}
const BROWSER_STATUS_WIDGET = {
	id: "browser.status",
	pluginId: "browser-workspace",
	order: 75,
	defaultEnabled: true,
	Component: BrowserStatusSidebarWidget
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/music-player.js
const MEDIA_ERROR_NAMES = {
	1: "MEDIA_ERR_ABORTED",
	2: "MEDIA_ERR_NETWORK",
	3: "MEDIA_ERR_DECODE",
	4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
};
function statusLabel(state) {
	if (state.kind === "playing") return state.isPaused ? "Paused" : "Live";
	if (state.kind === "loading") return "Loading";
	if (state.kind === "error") return "Unavailable";
	return "Idle";
}
function MusicPlayerSidebarWidget(_props) {
	const audioRef = useRef(null);
	const lastAttachedTrack = useRef(null);
	const [player, setPlayer] = useState({ kind: "idle" });
	const [audioError, setAudioError] = useState(null);
	const [audioPaused, setAudioPaused] = useState(true);
	const isPlaying = player.kind === "playing";
	const pollOnce = useCallback(async () => {
		setPlayer((prev) => prev.kind === "idle" ? { kind: "loading" } : prev);
		try {
			const res = await fetch(resolveApiUrl("/music-player/status"));
			const data = await res.json();
			if (!res.ok) {
				setPlayer({
					kind: "error",
					message: data.error ?? res.statusText
				});
				return;
			}
			if (data.track?.title && data.guildId && data.streamUrl) {
				setPlayer({
					kind: "playing",
					title: data.track.title,
					guildId: data.guildId,
					streamUrl: resolveApiUrl(data.streamUrl),
					isPaused: data.isPaused === true
				});
				return;
			}
			setPlayer({ kind: "idle" });
			setAudioPaused(true);
		} catch {
			setPlayer({
				kind: "error",
				message: "Could not reach the music player."
			});
			setAudioPaused(true);
		}
	}, []);
	useEffect(() => {
		pollOnce();
		const id = window.setInterval(() => void pollOnce(), 5e3);
		return () => window.clearInterval(id);
	}, [pollOnce]);
	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		if (player.kind !== "playing") {
			el.pause();
			el.removeAttribute("src");
			el.load();
			lastAttachedTrack.current = null;
			return;
		}
		const key = `${player.guildId}::${player.title}`;
		if (lastAttachedTrack.current !== key) {
			lastAttachedTrack.current = key;
			setAudioError(null);
			setAudioPaused(true);
			el.src = player.streamUrl;
			el.load();
		}
		if (player.isPaused) {
			el.pause();
			setAudioPaused(true);
			return;
		}
		el.play().catch(() => {});
	}, [player]);
	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		const handlePlay = () => setAudioPaused(false);
		const handlePause = () => setAudioPaused(true);
		const handler = () => {
			const err = el.error;
			const code = err?.code ?? 0;
			setAudioError(`${MEDIA_ERROR_NAMES[code] ?? `UNKNOWN(${code})`}: ${err?.message || "no details"}`);
		};
		el.addEventListener("play", handlePlay);
		el.addEventListener("pause", handlePause);
		el.addEventListener("error", handler);
		return () => {
			el.removeEventListener("play", handlePlay);
			el.removeEventListener("pause", handlePause);
			el.removeEventListener("error", handler);
		};
	}, []);
	function togglePlayback() {
		const el = audioRef.current;
		if (!el || player.kind !== "playing" || !player.streamUrl) return;
		if (el.paused) {
			el.play();
			return;
		}
		el.pause();
	}
	return (0, import_jsx_runtime.jsx)(WidgetSection, {
		title: "Music",
		icon: (0, import_jsx_runtime.jsx)(Music, { className: "h-3.5 w-3.5" }),
		testId: "chat-widget-music-player",
		action: (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			onClick: () => void pollOnce(),
			"aria-label": "Refresh music player",
			className: "inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
			children: (0, import_jsx_runtime.jsx)(RefreshCw, {
				className: "h-3 w-3",
				"aria-hidden": true
			})
		}),
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-2 pt-0.5",
			children: [
				isPlaying ? (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [
						(0, import_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: togglePlayback,
							"aria-label": audioPaused ? "Play music" : "Pause music",
							title: audioPaused ? "Play" : "Pause",
							className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
							children: audioPaused ? (0, import_jsx_runtime.jsx)(Play, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							}) : (0, import_jsx_runtime.jsx)(Pause, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: `h-1.5 w-1.5 shrink-0 rounded-full ${player.isPaused ? "bg-warn" : "bg-ok"}`,
							"aria-hidden": true
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "min-w-0 flex-1 truncate text-3xs font-semibold text-txt",
							children: player.title
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 text-3xs uppercase tracking-wider text-muted/70",
							children: statusLabel(player)
						})
					]
				}) : (0, import_jsx_runtime.jsx)(EmptyWidgetState, {
					icon: (0, import_jsx_runtime.jsx)(Music, { className: "h-5 w-5" }),
					title: player.kind === "error" ? player.message : "No music stream is active.",
					description: "Ask the agent to play music in chat."
				}),
				(0, import_jsx_runtime.jsx)("audio", {
					ref: audioRef,
					className: "hidden",
					"aria-label": "Agent music stream"
				}),
				audioError ? (0, import_jsx_runtime.jsx)("p", {
					className: "break-words font-mono text-3xs text-warn",
					children: audioError
				}) : null
			]
		})
	});
}
const MUSIC_PLAYER_WIDGET = {
	id: "music-player.stream",
	pluginId: "music-player",
	order: 125,
	defaultEnabled: true,
	Component: MusicPlayerSidebarWidget
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/todo.js
const TODO_REFRESH_INTERVAL_MS = 15e3;
const MAX_VISIBLE_TODOS = 8;
const fallbackTranslate = (key, vars) => typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
function sortTodosForWidget(todos) {
	return [...todos].sort((left, right) => {
		if (left.isCompleted !== right.isCompleted) return left.isCompleted ? 1 : -1;
		if (left.isUrgent !== right.isUrgent) return left.isUrgent ? -1 : 1;
		const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
		const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
		if (leftPriority !== rightPriority) return leftPriority - rightPriority;
		return left.name.localeCompare(right.name);
	});
}
function dedupeTodos(todos) {
	const byId = /* @__PURE__ */ new Map();
	for (const todo of todos) byId.set(todo.id, todo);
	return sortTodosForWidget([...byId.values()]);
}
function TodoRow({ todo }) {
	const showDescription = todo.description.trim().length > 0 && todo.description !== todo.name;
	const showType = todo.type.trim().length > 0 && todo.type !== "task";
	return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-lg border border-border/50 bg-bg/70 p-3",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start gap-2",
			children: [(0, import_jsx_runtime.jsx)("span", { className: `mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${todo.isUrgent ? "bg-danger" : todo.priority != null ? "bg-accent" : "bg-muted"}` }), (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-1.5",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "min-w-0 truncate text-xs font-semibold text-txt",
							children: todo.name
						}),
						todo.isUrgent ? (0, import_jsx_runtime.jsx)(Badge, {
							variant: "secondary",
							className: "text-3xs text-danger",
							children: "Urgent"
						}) : null,
						todo.priority != null ? (0, import_jsx_runtime.jsxs)(Badge, {
							variant: "secondary",
							className: "text-3xs",
							children: ["P", todo.priority]
						}) : null,
						showType ? (0, import_jsx_runtime.jsx)(Badge, {
							variant: "secondary",
							className: "text-3xs",
							children: todo.type
						}) : null
					]
				}), showDescription ? (0, import_jsx_runtime.jsx)("p", {
					className: "mt-1 line-clamp-2 text-xs-tight leading-5 text-muted",
					children: todo.description
				}) : null]
			})]
		})
	});
}
function TodoItemsContent({ todos, loading }) {
	const openTodos = todos.filter((todo) => !todo.isCompleted);
	const hiddenCompletedCount = todos.length - openTodos.length;
	const visibleTodos = openTodos.slice(0, MAX_VISIBLE_TODOS);
	const remainingCount = openTodos.length - visibleTodos.length;
	if (loading && todos.length === 0) return (0, import_jsx_runtime.jsx)("div", {
		className: "py-3 text-xs text-muted",
		children: "Refreshing todos…"
	});
	if (openTodos.length === 0) return (0, import_jsx_runtime.jsx)(EmptyWidgetState, {
		icon: (0, import_jsx_runtime.jsx)(ListTodo, { className: "h-8 w-8" }),
		title: "No open todos"
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-2",
		children: [
			visibleTodos.map((todo) => (0, import_jsx_runtime.jsx)(TodoRow, { todo }, todo.id)),
			remainingCount > 0 ? (0, import_jsx_runtime.jsxs)("p", {
				className: "px-1 text-xs-tight text-muted",
				children: [
					"+",
					remainingCount,
					" more open todo",
					remainingCount === 1 ? "" : "s"
				]
			}) : null,
			hiddenCompletedCount > 0 ? (0, import_jsx_runtime.jsxs)("p", {
				className: "px-1 text-xs-tight text-muted",
				children: [
					hiddenCompletedCount,
					" completed todo",
					hiddenCompletedCount === 1 ? "" : "s",
					" hidden"
				]
			}) : null
		]
	});
}
function TodoSidebarWidget(_props) {
	const app = useApp();
	const workbench = app?.workbench;
	const t = app?.t ?? fallbackTranslate;
	const [todos, setTodos] = useState(() => dedupeTodos(workbench?.todos ?? []));
	const [todosLoading, setTodosLoading] = useState(false);
	useEffect(() => {
		setTodos(dedupeTodos(workbench?.todos ?? []));
	}, [workbench?.todos]);
	const loadTodos = useCallback(async (silent = false) => {
		if (!silent) setTodosLoading(true);
		try {
			setTodos(dedupeTodos((await client.listWorkbenchTodos()).todos));
		} catch {
			if ((workbench?.todos?.length ?? 0) > 0) setTodos(dedupeTodos(workbench?.todos ?? []));
		} finally {
			setTodosLoading(false);
		}
	}, [workbench?.todos]);
	useEffect(() => {
		let active = true;
		(async () => {
			await loadTodos(todos.length > 0);
			if (!active) return;
		})();
		const intervalId = setInterval(() => {
			if (!active) return;
			loadTodos(true);
		}, TODO_REFRESH_INTERVAL_MS);
		return () => {
			active = false;
			clearInterval(intervalId);
		};
	}, [loadTodos, todos.length]);
	return (0, import_jsx_runtime.jsx)(WidgetSection, {
		title: t("taskseventspanel.Todos", { defaultValue: "Todos" }),
		icon: (0, import_jsx_runtime.jsx)(ListTodo, { className: "h-4 w-4" }),
		testId: "chat-widget-todos",
		children: (0, import_jsx_runtime.jsx)(TodoItemsContent, {
			todos,
			loading: todosLoading
		})
	});
}
const TODO_PLUGIN_WIDGETS = [{
	id: "todo.items",
	pluginId: "todo",
	order: 100,
	defaultEnabled: true,
	Component: TodoSidebarWidget
}];

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/inventory/chainConfig.js
/**
* Central chain configuration registry.
*
* Every chain-specific constant (explorer URLs, native token details,
* gas thresholds, stablecoin addresses, logo URLs, address validation)
* lives here so that UI components and hooks can derive values from
* a single source of truth rather than scattering inline constants.
*/
const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHAIN_CONFIGS = {
	bsc: {
		chainKey: "bsc",
		name: "BSC",
		nativeSymbol: "BNB",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://bscscan.com",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
		trustWalletSlug: "smartchain",
		gasReadyThreshold: .005,
		swapGasReserve: .002,
		stablecoins: [{
			symbol: "USDT",
			address: "0x55d398326f99059fF775485246999027B3197955"
		}, {
			symbol: "USDC",
			address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "bsc",
		nameVariants: [
			"bsc",
			"bnb chain",
			"bnb smart chain"
		],
		color: "var(--color-chain-bsc)"
	},
	avax: {
		chainKey: "avax",
		name: "Avalanche",
		nativeSymbol: "AVAX",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://snowtrace.io",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png",
		trustWalletSlug: "avalanchec",
		gasReadyThreshold: .01,
		swapGasReserve: .005,
		stablecoins: [{
			symbol: "USDT",
			address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"
		}, {
			symbol: "USDC",
			address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "avalanche",
		nameVariants: [
			"avax",
			"avalanche",
			"c-chain",
			"avalanche c-chain"
		],
		color: "#e84142"
	},
	solana: {
		chainKey: "solana",
		name: "Solana",
		nativeSymbol: "SOL",
		nativeDecimals: 9,
		isEvm: false,
		explorerBaseUrl: "https://solscan.io",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
		trustWalletSlug: "solana",
		gasReadyThreshold: .01,
		swapGasReserve: .005,
		stablecoins: [{
			symbol: "USDC",
			address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
		}],
		addressRegex: SOLANA_ADDRESS_RE,
		dexScreenerChainId: "solana",
		nameVariants: ["solana", "sol"],
		color: "var(--color-chain-sol)"
	},
	ethereum: {
		chainKey: "ethereum",
		name: "Ethereum",
		nativeSymbol: "ETH",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://etherscan.io",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
		trustWalletSlug: "ethereum",
		gasReadyThreshold: .005,
		swapGasReserve: .002,
		stablecoins: [{
			symbol: "USDT",
			address: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
		}, {
			symbol: "USDC",
			address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "ethereum",
		nameVariants: [
			"ethereum",
			"mainnet",
			"eth"
		],
		color: "var(--color-chain-eth)"
	},
	base: {
		chainKey: "base",
		name: "Base",
		nativeSymbol: "ETH",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://basescan.org",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
		trustWalletSlug: "base",
		gasReadyThreshold: .005,
		swapGasReserve: .001,
		stablecoins: [{
			symbol: "USDC",
			address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "base",
		nameVariants: ["base"],
		color: "var(--color-chain-base)"
	},
	arbitrum: {
		chainKey: "arbitrum",
		name: "Arbitrum",
		nativeSymbol: "ETH",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://arbiscan.io",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
		trustWalletSlug: null,
		gasReadyThreshold: .005,
		swapGasReserve: .001,
		stablecoins: [{
			symbol: "USDC",
			address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "arbitrum",
		nameVariants: ["arbitrum"],
		color: "var(--color-chain-arb)"
	},
	optimism: {
		chainKey: "optimism",
		name: "Optimism",
		nativeSymbol: "ETH",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://optimistic.etherscan.io",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
		trustWalletSlug: null,
		gasReadyThreshold: .005,
		swapGasReserve: .001,
		stablecoins: [{
			symbol: "USDC",
			address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "optimism",
		nameVariants: ["optimism"],
		color: "var(--color-chain-op)"
	},
	polygon: {
		chainKey: "polygon",
		name: "Polygon",
		nativeSymbol: "MATIC",
		nativeDecimals: 18,
		isEvm: true,
		explorerBaseUrl: "https://polygonscan.com",
		explorerTokenPath: "/token/{address}",
		explorerTxPath: "/tx/{hash}",
		nativeLogoUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png",
		trustWalletSlug: "polygon",
		gasReadyThreshold: .5,
		swapGasReserve: .1,
		stablecoins: [{
			symbol: "USDT",
			address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
		}, {
			symbol: "USDC",
			address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
		}],
		addressRegex: HEX_ADDRESS_RE,
		dexScreenerChainId: "polygon",
		nameVariants: ["polygon"],
		color: "var(--color-chain-pol)"
	}
};
/** Pre-built lookup table from lowercase variant to ChainConfig. */
const _variantMap = /* @__PURE__ */ new Map();
for (const config of Object.values(CHAIN_CONFIGS)) for (const variant of config.nameVariants) _variantMap.set(variant.toLowerCase(), config);
/** Resolve a chain name (case-insensitive, trimmed) to its config. */
function getChainConfig(chainName) {
	return _variantMap.get(chainName.trim().toLowerCase()) ?? null;
}
/**
* Resolve a chain name string to a `ChainKey`.
* Returns `null` for unrecognised chains.
*/
function resolveChainKey(chainName) {
	return getChainConfig(chainName)?.chainKey ?? null;
}
/**
* Build the explorer URL for a token on the given chain.
* Returns `null` if the chain is unknown or the address is invalid.
*/
function getExplorerTokenUrl(chainName, address) {
	const config = getChainConfig(chainName);
	if (!config) return null;
	const trimmed = address.trim();
	if (!config.addressRegex.test(trimmed)) return null;
	return `${config.explorerBaseUrl}${config.explorerTokenPath.replace("{address}", trimmed)}`;
}
/**
* Build the explorer URL for a transaction on the given chain.
* Returns `null` if the chain is unknown.
*/
function getExplorerTxUrl(chainName, hash) {
	const config = getChainConfig(chainName);
	if (!config) return null;
	return `${config.explorerBaseUrl}${config.explorerTxPath.replace("{hash}", hash.trim())}`;
}
/**
* Get the native token logo URL for a chain, or `null` if unknown.
*/
function getNativeLogoUrl(chainName) {
	return getChainConfig(chainName)?.nativeLogoUrl ?? null;
}
/**
* Get the TrustWallet CDN logo URL for a contract token on the given chain.
* Returns `null` if the chain has no TrustWallet slug or no contract address.
*/
function getContractLogoUrl(chainName, contractAddress) {
	if (!contractAddress) return null;
	const config = getChainConfig(chainName);
	if (!config?.trustWalletSlug) return null;
	return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${config.trustWalletSlug}/assets/${contractAddress}/logo.png`;
}
/**
* Resolve a stablecoin address on a given chain by symbol.
* Returns `null` if not found.
*/
function getStablecoinAddress(chainName, symbol) {
	const config = getChainConfig(chainName);
	if (!config) return null;
	const upper = symbol.trim().toUpperCase();
	return config.stablecoins.find((s) => s.symbol === upper)?.address ?? null;
}
/** The primary chains we want to support prominently. */
const PRIMARY_CHAIN_KEYS = [
	"ethereum",
	"base",
	"bsc",
	"avax",
	"solana"
];
/**
* Map a chain focus key (ChainKey or "all") to the legacy WalletRpcChain used
* by legacyCustomChains. Returns null for "all" or unknown chains.
*/
function chainKeyToWalletRpcChain(chainFocus) {
	if (chainFocus === "all" || chainFocus === "multi") return null;
	if (chainFocus === "bsc" || chainFocus === "solana") return chainFocus;
	return [
		"ethereum",
		"base",
		"avax",
		"arbitrum",
		"optimism",
		"polygon"
	].includes(chainFocus) ? "evm" : null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/inventory/media-url.js
/**
* Normalize NFT/token image URLs for browser rendering.
* Wallet APIs often return ipfs://, ipns://, or ar:// URIs that <img> cannot load directly.
*/
const IPFS_GATEWAY_BASE = "https://ipfs.io/ipfs/";
const IPNS_GATEWAY_BASE = "https://ipfs.io/ipns/";
const ARWEAVE_GATEWAY_BASE = "https://arweave.net/";
function normalizeInventoryImageUrl(raw) {
	const value = raw?.trim();
	if (!value) return null;
	if (/^(?:https?:|data:image\/|blob:)/i.test(value)) return value;
	if (/^ipfs:\/\//i.test(value)) {
		const cidPath = value.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
		return cidPath ? `${IPFS_GATEWAY_BASE}${cidPath}` : null;
	}
	if (/^ipns:\/\//i.test(value)) {
		const namePath = value.replace(/^ipns:\/\//i, "");
		return namePath ? `${IPNS_GATEWAY_BASE}${namePath}` : null;
	}
	if (/^ar:\/\//i.test(value)) {
		const txId = value.replace(/^ar:\/\//i, "");
		return txId ? `${ARWEAVE_GATEWAY_BASE}${txId}` : null;
	}
	return null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/chat/widgets/wallet-status.js
const DUST_THRESHOLD_USD = .01;
const COPY_FEEDBACK_MS = 1200;
const EVM_CHAIN_ORDER = [
	"ethereum",
	"base",
	"arbitrum",
	"optimism",
	"polygon",
	"bsc",
	"avax"
];
const EVM_CHAIN_KEYS = new Set(EVM_CHAIN_ORDER);
const CHAIN_DISPLAY_LABELS = {
	ethereum: "Ethereum",
	base: "Base",
	arbitrum: "Arbitrum",
	optimism: "Optimism",
	polygon: "Polygon",
	bsc: "BNB Chain",
	avax: "Avalanche",
	solana: "Solana"
};
function shortenAddress(value) {
	if (!value) return null;
	if (value.length <= 10) return value;
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function parseUsd(value) {
	if (typeof value !== "string") return 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
function formatUsd(value) {
	if (value >= 1e3) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(2)}`;
}
function hasPositiveBalance(value) {
	if (!value) return false;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0;
}
function normalizeEvmChainKeys(chainNames) {
	const seen = /* @__PURE__ */ new Set();
	for (const chainName of chainNames) {
		const chainKey = resolveChainKey(chainName);
		if (chainKey && EVM_CHAIN_KEYS.has(chainKey)) seen.add(chainKey);
	}
	return EVM_CHAIN_ORDER.filter((chainKey) => seen.has(chainKey));
}
function ChainBadge({ chain }) {
	const [errored, setErrored] = useState(false);
	const label = CHAIN_DISPLAY_LABELS[chain];
	const url = errored ? null : normalizeInventoryImageUrl(getNativeLogoUrl(chain)) ?? null;
	if (url) return (0, import_jsx_runtime.jsx)("img", {
		src: url,
		alt: label,
		title: label,
		width: 16,
		height: 16,
		className: "inline-flex h-4 w-4 shrink-0 rounded-full bg-bg/40 object-cover",
		onError: () => setErrored(true)
	});
	return (0, import_jsx_runtime.jsx)("span", {
		className: "inline-flex h-4 shrink-0 items-center rounded-full border border-border/35 bg-bg/40 px-1.5 font-mono text-[0.52rem] font-semibold leading-none text-muted",
		title: label,
		role: "img",
		"aria-label": label,
		children: label.slice(0, 3).toUpperCase()
	});
}
function ChainBadges({ chains }) {
	return (0, import_jsx_runtime.jsx)("span", {
		className: "flex min-w-0 flex-wrap items-center gap-1",
		children: chains.map((chain) => (0, import_jsx_runtime.jsx)(ChainBadge, { chain }, chain))
	});
}
function CopyAddressButton({ value, label }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [copied]);
	async function onClick(event) {
		event.preventDefault();
		event.stopPropagation();
		try {
			if (typeof navigator === "undefined" || !navigator.clipboard) return;
			await navigator.clipboard.writeText(value);
			setCopied(true);
		} catch {
			return;
		}
	}
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		onClick,
		"aria-label": copied ? `${label} copied` : `Copy ${label}`,
		title: copied ? "Copied" : "Copy",
		className: "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
		children: copied ? (0, import_jsx_runtime.jsx)(Check, {
			className: "h-3 w-3",
			"aria-hidden": true
		}) : (0, import_jsx_runtime.jsx)(Copy, {
			className: "h-3 w-3",
			"aria-hidden": true
		})
	});
}
function WalletStatusSidebarWidget(_props) {
	const { walletEnabled, walletAddresses, walletConfig, walletBalances, loadWalletConfig, loadBalances, setTab } = useApp();
	useEffect(() => {
		if (walletEnabled === false) return;
		if (walletConfig === null) loadWalletConfig();
		if (walletBalances !== null) return;
		loadBalances();
	}, [
		walletEnabled,
		walletConfig,
		walletBalances,
		loadWalletConfig,
		loadBalances
	]);
	const evmAddress = walletAddresses?.evmAddress ?? null;
	const solanaAddress = walletAddresses?.solanaAddress ?? null;
	const evmShort = shortenAddress(evmAddress);
	const solanaShort = shortenAddress(solanaAddress);
	const evmChains = normalizeEvmChainKeys([...walletConfig?.evmChains ?? [], ...walletBalances?.evm?.chains.map((chain) => chain.chain) ?? []]);
	const walletSummary = useMemo(() => {
		let assetCount = 0;
		let totalUsd = 0;
		if (walletBalances?.evm) for (const chain of walletBalances.evm.chains) {
			const nativeUsd = parseUsd(chain.nativeValueUsd);
			totalUsd += nativeUsd;
			if (nativeUsd >= DUST_THRESHOLD_USD || hasPositiveBalance(chain.nativeBalance)) assetCount += 1;
			for (const token of chain.tokens) {
				const tokenUsd = parseUsd(token.valueUsd);
				totalUsd += tokenUsd;
				if (tokenUsd >= DUST_THRESHOLD_USD || hasPositiveBalance(token.balance)) assetCount += 1;
			}
		}
		if (walletBalances?.solana) {
			const nativeUsd = parseUsd(walletBalances.solana.solValueUsd);
			totalUsd += nativeUsd;
			if (nativeUsd >= DUST_THRESHOLD_USD || hasPositiveBalance(walletBalances.solana.solBalance)) assetCount += 1;
			for (const token of walletBalances.solana.tokens) {
				const tokenUsd = parseUsd(token.valueUsd);
				totalUsd += tokenUsd;
				if (tokenUsd >= DUST_THRESHOLD_USD || hasPositiveBalance(token.balance)) assetCount += 1;
			}
		}
		return {
			assetCount,
			totalUsd
		};
	}, [walletBalances]);
	if (walletEnabled === false) return null;
	const hasAnyAddress = Boolean(evmAddress || solanaAddress);
	const hasAnyBalanceRow = walletSummary.assetCount > 0;
	return (0, import_jsx_runtime.jsx)(WidgetSection, {
		title: "Wallet",
		icon: (0, import_jsx_runtime.jsx)(Wallet, { className: "h-3.5 w-3.5" }),
		testId: "chat-widget-wallet-status",
		onTitleClick: () => setTab("inventory"),
		children: hasAnyAddress ? (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-1.5 px-1 pt-0.5",
			children: [
				evmAddress ? (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between gap-2 text-3xs",
					"data-testid": "chat-widget-wallet-row-evm-address",
					children: [(0, import_jsx_runtime.jsx)(ChainBadges, { chains: evmChains }), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1 min-w-0",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "truncate font-mono text-txt",
							title: evmAddress,
							children: evmShort
						}), (0, import_jsx_runtime.jsx)(CopyAddressButton, {
							value: evmAddress,
							label: "EVM address"
						})]
					})]
				}) : null,
				solanaAddress ? (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between gap-2 text-3xs",
					"data-testid": "chat-widget-wallet-row-solana-address",
					children: [(0, import_jsx_runtime.jsx)(ChainBadge, { chain: "solana" }), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1 min-w-0",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "truncate font-mono text-txt",
							title: solanaAddress,
							children: solanaShort
						}), (0, import_jsx_runtime.jsx)(CopyAddressButton, {
							value: solanaAddress,
							label: "Solana address"
						})]
					})]
				}) : null,
				hasAnyBalanceRow ? (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-1 flex flex-col gap-1 border-t border-border/20 pt-1.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-between text-3xs",
						"data-testid": "chat-widget-wallet-row-assets",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "truncate text-muted",
							children: "Assets"
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 text-txt",
							children: walletSummary.assetCount
						})]
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-between text-3xs",
						"data-testid": "chat-widget-wallet-row-value",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "truncate text-muted",
							children: "Value"
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 text-txt",
							children: formatUsd(walletSummary.totalUsd)
						})]
					})]
				}) : null
			]
		}) : (0, import_jsx_runtime.jsx)(EmptyWidgetState, {
			icon: (0, import_jsx_runtime.jsx)(Wallet, { className: "h-5 w-5" }),
			title: "No wallet addresses yet"
		})
	});
}
const WALLET_STATUS_WIDGET = {
	id: "wallet.status",
	pluginId: "wallet",
	order: 70,
	defaultEnabled: true,
	Component: WalletStatusSidebarWidget
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/widgets/registry.js
/**
* Plugin widget registry.
*
* Maintains a static map of plugin widget React components (bundled plugins)
* and resolves widgets for a given slot based on plugin state.
*
* Third-party plugins without bundled React components can provide a `uiSpec`
* in their widget declaration, which gets rendered by `UiRenderer` via the
* `WidgetHost` component.
*/
const COMPONENT_REGISTRY = /* @__PURE__ */ new Map();
/**
* Register a bundled React component for a widget declaration.
* Key format: `${pluginId}/${declarationId}`.
*/
function registerWidgetComponent(pluginId, declarationId, Component) {
	COMPONENT_REGISTRY.set(`${pluginId}/${declarationId}`, Component);
}
/** Look up a registered component. */
function getWidgetComponent(pluginId, declarationId) {
	return COMPONENT_REGISTRY.get(`${pluginId}/${declarationId}`);
}
/**
* Adapts existing ChatSidebarWidgetDefinition[] to the new registry format.
* These legacy widgets used `ChatSidebarWidgetProps` which is compatible with
* `WidgetProps` (events + clearEvents).
*/
function seedLegacyWidgets(definitions) {
	for (const def of definitions) registerWidgetComponent(def.pluginId, def.id, def.Component);
}
seedLegacyWidgets(AGENT_ORCHESTRATOR_PLUGIN_WIDGETS);
seedLegacyWidgets(TODO_PLUGIN_WIDGETS);
seedLegacyWidgets([
	WALLET_STATUS_WIDGET,
	BROWSER_STATUS_WIDGET,
	MUSIC_PLAYER_WIDGET
]);
registerWidgetComponent("music-library", "music-library.playlists", MusicLibraryCharacterWidget);
/**
* Public API for plugins outside app-core to seed their own widget components.
* Call this when your plugin loads (e.g. via side-effect import of a widgets
* module). Each definition must be a `ChatSidebarWidgetDefinition`.
*/
function registerBuiltinWidgets(definitions) {
	seedLegacyWidgets(definitions);
}
/**
* Public API for plugins outside app-core to append widget declarations to the
* built-in fallback list. Declarations appear in the sidebar when the runtime
* plugin snapshot isn't available or when the plugin is in the fallback set.
*/
function registerBuiltinWidgetDeclarations(declarations, options) {
	for (const decl of declarations) BUILTIN_WIDGET_DECLARATIONS.push(decl);
	if (options?.fallbackPluginIds) for (const id of options.fallbackPluginIds) BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.add(id);
}
const BUILTIN_WIDGET_DECLARATIONS = [
	{
		id: "agent-orchestrator.apps",
		pluginId: "agent-orchestrator",
		slot: "chat-sidebar",
		label: "Apps",
		icon: "Activity",
		order: 150,
		defaultEnabled: true
	},
	{
		id: "agent-orchestrator.activity",
		pluginId: "agent-orchestrator",
		slot: "chat-sidebar",
		label: "Activity",
		icon: "Activity",
		order: 300,
		defaultEnabled: true
	},
	{
		id: WALLET_STATUS_WIDGET.id,
		pluginId: WALLET_STATUS_WIDGET.pluginId,
		slot: "chat-sidebar",
		label: "Wallet",
		icon: "Wallet",
		order: WALLET_STATUS_WIDGET.order,
		defaultEnabled: WALLET_STATUS_WIDGET.defaultEnabled
	},
	{
		id: BROWSER_STATUS_WIDGET.id,
		pluginId: BROWSER_STATUS_WIDGET.pluginId,
		slot: "chat-sidebar",
		label: "Browser",
		icon: "Globe",
		order: BROWSER_STATUS_WIDGET.order,
		defaultEnabled: BROWSER_STATUS_WIDGET.defaultEnabled
	},
	{
		id: MUSIC_PLAYER_WIDGET.id,
		pluginId: MUSIC_PLAYER_WIDGET.pluginId,
		slot: "chat-sidebar",
		label: "Music",
		icon: "Music",
		order: MUSIC_PLAYER_WIDGET.order,
		defaultEnabled: MUSIC_PLAYER_WIDGET.defaultEnabled
	},
	{
		id: "music-library.playlists",
		pluginId: "music-library",
		slot: "character",
		label: "Music Library",
		icon: "ListMusic",
		order: 250,
		defaultEnabled: true
	}
];
/**
* Some bundled widgets intentionally stay visible even when the runtime plugin
* snapshot omits their feature IDs because the UI has compat-backed data
* sources for them. Generic todo widgets do not qualify here — Eliza does not
* ship a runtime todo plugin, and leaving the fallback enabled crowds out the
* LifeOps-first sidebar with a stale generic tasks panel.
*/
const BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS = new Set([
	"agent-orchestrator",
	"wallet",
	"browser-workspace"
]);
const ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS = new Set(["music-player"]);
function isWidgetEnabled(declaration, plugins, source) {
	if (source === "builtin" && declaration.defaultEnabled !== false && ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS.has(declaration.pluginId)) return true;
	if (plugins.length === 0) return declaration.defaultEnabled !== false && (source !== "builtin" || BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId));
	const plugin = plugins.find((p) => p.id === declaration.pluginId);
	if (!plugin) return source === "builtin" && declaration.defaultEnabled !== false && BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId);
	return plugin.isActive === true || plugin.enabled !== false;
}
/**
* Resolve all enabled widgets for a slot.
*
* Merges built-in declarations with any server-provided declarations
* (from PluginInfo.widgets), deduplicating by declaration ID.
*/
function resolveWidgetsForSlot(slot, plugins, serverDeclarations) {
	const declarationMap = /* @__PURE__ */ new Map();
	for (const decl of BUILTIN_WIDGET_DECLARATIONS) if (decl.slot === slot) declarationMap.set(`${decl.pluginId}/${decl.id}`, {
		declaration: decl,
		source: "builtin"
	});
	if (serverDeclarations) {
		for (const decl of serverDeclarations) if (decl.slot === slot) declarationMap.set(`${decl.pluginId}/${decl.id}`, {
			declaration: decl,
			source: "server"
		});
	}
	const results = [];
	for (const { declaration, source } of declarationMap.values()) {
		if (!isWidgetEnabled(declaration, plugins, source)) continue;
		const Component = getWidgetComponent(declaration.pluginId, declaration.id);
		if (Component || declaration.uiSpec) results.push({
			declaration,
			Component: Component ?? null
		});
	}
	results.sort((a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100));
	return results;
}
function resolveChatSidebarWidgets(plugins) {
	return resolveWidgetsForSlot("chat-sidebar", plugins).map((w) => ({
		id: w.declaration.id,
		pluginId: w.declaration.pluginId,
		order: w.declaration.order ?? 100,
		defaultEnabled: w.declaration.defaultEnabled !== false,
		Component: w.Component
	}));
}

//#endregion
export { shouldShowAppInAppsView as A, resolveRuntimeImageUrl as B, APP_CATALOG_SECTION_LABELS as C, getAppShortName as D, getAppCatalogSectionKey as E, getInternalToolApps as F, overlayAppToRegistryInfo as G, getAvailableOverlayApps as H, isInternalToolApp as I, registerOverlayApp as K, AppHero as L, getInternalToolAppHasDetailsPage as M, getInternalToolAppTargetTab as N, getAppSlug as O, getInternalToolAppWindowPath as P, AppIdentityTile as R, loadMergedCatalogApps as S, findAppBySlug as T, getOverlayApp as U, getAllOverlayApps as V, isOverlayApp as W, getStablecoinAddress as _, registerWidgetComponent as a, WidgetSection as b, normalizeInventoryImageUrl as c, chainKeyToWalletRpcChain as d, getChainConfig as f, getNativeLogoUrl as g, getExplorerTxUrl as h, registerBuiltinWidgets as i, getInternalToolAppDescriptors as j, groupAppsForCatalog as k, CHAIN_CONFIGS as l, getExplorerTokenUrl as m, getWidgetComponent as n, resolveChatSidebarWidgets as o, getContractLogoUrl as p, registerBuiltinWidgetDeclarations as r, resolveWidgetsForSlot as s, BUILTIN_WIDGET_DECLARATIONS as t, PRIMARY_CHAIN_KEYS as u, resolveChainKey as v, filterAppsForCatalog as w, getRunAttentionReasons as x, EmptyWidgetState as y, getAppCategoryIcon as z };