import { D as require_jsx_runtime, S as invokeDesktopBridgeRequest, T as subscribeDesktopBridgeEvent, k as __exportAll, n as isElectrobunRuntime } from "./electrobun-runtime-zXJ9acDW.js";
import { d as client, n as useApp, s as formatTime } from "./useApp-Dh-r7aR7.js";
import { Da as shouldUseHashNavigation, Jr as openExternalUrl, Pa as useBranding, Sa as isAppWindowRoute, Yr as preOpenWindow, ba as getWindowNavigationPath, pt as useTranslation, qr as navigatePreOpenedWindow, ua as resolveApiUrl, va as getAppSlugFromPath } from "./state-BC9WO-N8.js";
import { B as resolveRuntimeImageUrl, C as APP_CATALOG_SECTION_LABELS, D as getAppShortName, E as getAppCatalogSectionKey, F as getInternalToolApps, G as overlayAppToRegistryInfo, I as isInternalToolApp, L as AppHero, M as getInternalToolAppHasDetailsPage, N as getInternalToolAppTargetTab, O as getAppSlug, P as getInternalToolAppWindowPath, T as findAppBySlug, V as getAllOverlayApps, W as isOverlayApp, j as getInternalToolAppDescriptors, k as groupAppsForCatalog, n as getWidgetComponent, w as filterAppsForCatalog, x as getRunAttentionReasons, z as getAppCategoryIcon } from "./registry-B89cdzKO.js";
import { t as AppPageSidebar } from "./AppPageSidebar-myyOdXbd.js";
import { d as useMediaQuery } from "./hooks-C3v9uETL.js";
import { packageNameToAppRouteSlug } from "@elizaos/shared";
import { Button, Input, PageLayout, SidebarContent, SidebarPanel, SidebarScrollRegion, Skeleton, useDocumentVisibility, useIntervalWhenDocumentVisible, useTimeout } from "@elizaos/ui";
import { Pin, PinOff, Play, Rocket, Settings, Square, Star, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/viewer-auth.js
function normalizeEmbedFlag(value) {
	return value?.trim().toLowerCase() === "true";
}
function resolveEmbeddedViewerUrl(viewerUrl) {
	const normalized = viewerUrl.trim();
	if (!normalized) return normalized;
	if (normalized.startsWith("/api/")) return resolveApiUrl(normalized);
	return normalized;
}
function resolvePostMessageTargetOrigin(viewerUrl) {
	const resolvedViewerUrl = resolveEmbeddedViewerUrl(viewerUrl);
	try {
		const parsed = resolvedViewerUrl.startsWith("/") ? new URL(resolvedViewerUrl, window.location.origin) : new URL(resolvedViewerUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "*";
		return parsed.origin === "null" ? "*" : parsed.origin;
	} catch {
		return "*";
	}
}
function resolveViewerReadyEventType(payload) {
	if (!payload?.type) return null;
	const normalizedType = payload.type.trim();
	if (normalizedType.length === 0) return null;
	return normalizedType.replace(/_AUTH$/i, "_READY");
}
function buildViewerSessionKey(viewerUrl, payload) {
	return `${resolveEmbeddedViewerUrl(viewerUrl)}::${JSON.stringify(payload ?? null)}`;
}
function shouldUseEmbeddedAppViewer(run) {
	const viewer = run?.viewer;
	if (!viewer?.url) return false;
	if (viewer.postMessageAuth) return true;
	if (normalizeEmbedFlag(viewer.embedParams?.embedded)) return true;
	return typeof viewer.embedParams?.surface === "string";
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/widgets/visibility.js
/**
* User-controlled visibility overrides for `chat-sidebar` widgets.
*
* Layered on top of the existing two-stage gate in
* {@link ./registry.ts | resolveWidgetsForSlot}:
*
*   1. Plugin enabled?  →  declaration.defaultEnabled  →  user override
*
* The override layer is per-user, persisted to localStorage. When a widget's
* id is absent from the override map we fall back to `declaration.defaultEnabled`,
* so default flips don't reset users who never touched the toggle.
*
* Wallet/browser widgets that have not yet shipped get the same treatment:
* once their plugin loads them, they appear with `defaultEnabled` and the user
* can hide them via the same panel.
*/
const CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY = "eliza:chat-sidebar:visibility";
/**
* Synthetic widget id reserved for the bespoke `AppsSection` rendered in
* {@link ../components/chat/TasksEventsPanel.tsx}. Lets the same edit panel
* toggle Apps even though it's not a registry widget.
*/
const APPS_SECTION_VISIBILITY_KEY = "app-core/apps.section";
function widgetVisibilityKey(pluginId, id) {
	return `${pluginId}/${id}`;
}
function tryLocalStorage(fn, fallback) {
	if (typeof localStorage === "undefined") return fallback;
	try {
		return fn();
	} catch (err) {
		console.warn("[widget-visibility] localStorage operation failed:", err instanceof Error ? err.message : err);
		return fallback;
	}
}
function sanitizeOverrides(value) {
	if (!value || typeof value !== "object") return {};
	const next = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof key !== "string" || key.length === 0) continue;
		if (typeof raw === "boolean") next[key] = raw;
	}
	return next;
}
function loadChatSidebarVisibility() {
	return tryLocalStorage(() => {
		const raw = localStorage.getItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY);
		if (!raw) return { overrides: {} };
		return { overrides: sanitizeOverrides(JSON.parse(raw)) };
	}, { overrides: {} });
}
function saveChatSidebarVisibility(state) {
	tryLocalStorage(() => {
		const sanitized = sanitizeOverrides(state.overrides);
		if (Object.keys(sanitized).length === 0) {
			localStorage.removeItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY);
			return;
		}
		localStorage.setItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY, JSON.stringify(sanitized));
	}, void 0);
}
/**
* Decide whether a widget should be visible right now.
* - Explicit `true` override → visible.
* - Explicit `false` override → hidden.
* - No override → fall back to `defaultEnabled` (defaults to `true` when omitted,
*   matching the registry's `defaultEnabled !== false` convention).
*/
function isWidgetVisible(candidate, overrides) {
	const key = widgetVisibilityKey(candidate.pluginId, candidate.id);
	if (Object.hasOwn(overrides, key)) return overrides[key] === true;
	return candidate.defaultEnabled !== false;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/extensions/registry.js
/**
* Registry of app detail extension components keyed by the app's
* `uiExtension.detailPanelId` string.
*
* Apps register their detail extension on startup via side-effect import.
*/
const DETAIL_EXTENSION_COMPONENTS = /* @__PURE__ */ new Map();
/**
* Register a detail-panel extension component for a given panel id.
* Call this once per app at module load time (e.g. from the app's UI entry).
*
* @example
*   registerDetailExtension("babylon-operator-dashboard", BabylonDetailExtension);
*/
function registerDetailExtension(detailPanelId, component) {
	DETAIL_EXTENSION_COMPONENTS.set(detailPanelId, component);
}
function getAppDetailExtension(app) {
	const detailPanelId = app.uiExtension?.detailPanelId;
	if (!detailPanelId) return null;
	return DETAIL_EXTENSION_COMPONENTS.get(detailPanelId) ?? null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/surfaces/registry.js
/**
* Registry of operator surface components keyed by app package name.
*
* Apps register their surface on startup via side-effect import. The host
* app entry imports each game/app UI package which calls
* `registerOperatorSurface` during module initialization.
*/
const OPERATOR_SURFACE_COMPONENTS = /* @__PURE__ */ new Map();
/**
* Register an operator surface component for a given app package name.
* Call this once per app at module load time (e.g. from the app's UI entry).
*
* @example
*   registerOperatorSurface("@elizaos/app-babylon", BabylonOperatorSurface);
*/
function registerOperatorSurface(appName, component) {
	OPERATOR_SURFACE_COMPONENTS.set(appName, component);
}
function getAppOperatorSurface(appName) {
	if (!appName) return null;
	return OPERATOR_SURFACE_COMPONENTS.get(appName) ?? null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/GameView.js
/**
* Game View — embeds a running app's game client in an iframe.
*
* Features:
* - Full-screen iframe for game client
* - PostMessage auth for embedded app viewers
* - Split-screen mode with agent logs panel
* - Connection status indicator
*/
var import_jsx_runtime = require_jsx_runtime();
function buildDisconnectedSessionState(session) {
	if (!session) return null;
	return {
		...session,
		status: "disconnected",
		canSendCommands: false,
		controls: [],
		goalLabel: null,
		suggestedPrompts: [],
		telemetry: null,
		summary: session.displayName ? `Session unavailable: ${session.displayName}` : "Session unavailable."
	};
}
function getSteeringNotice(disposition, message) {
	if (disposition === "queued") return {
		tone: "info",
		ttlMs: 2600,
		text: message
	};
	if (disposition === "accepted") return {
		tone: "success",
		ttlMs: 2400,
		text: message
	};
	return {
		tone: "error",
		ttlMs: 3200,
		text: message
	};
}
function getSteeringFallbackMessage(disposition, defaultValue) {
	if (disposition === "queued") return "Command queued.";
	if (disposition === "accepted") return "Command accepted.";
	if (disposition === "unsupported") return "This run does not support that steering channel.";
	return defaultValue;
}
function getApiStatus$1(err) {
	if (err && typeof err === "object" && "status" in err && typeof err.status === "number") return err.status;
	return null;
}
/** Tag badge colors for logs panel. */
const TAG_COLORS = {
	agent: {
		bg: "rgba(99, 102, 241, 0.15)",
		fg: "rgb(99, 102, 241)"
	},
	game: {
		bg: "rgba(34, 197, 94, 0.15)",
		fg: "rgb(34, 197, 94)"
	},
	autonomy: {
		bg: "rgba(245, 158, 11, 0.15)",
		fg: "rgb(245, 158, 11)"
	},
	websocket: {
		bg: "rgba(20, 184, 166, 0.15)",
		fg: "rgb(20, 184, 166)"
	}
};
const DESKTOP_GAME_CLICK_AUDIT = [
	{
		id: "game-native-refresh",
		entryPoint: "game",
		label: "Refresh Native Window State",
		expectedAction: "Refresh canvas bounds and GPU window state.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	},
	{
		id: "game-native-focus",
		entryPoint: "game",
		label: "Focus Game Window",
		expectedAction: "Focus the native game canvas window.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	},
	{
		id: "game-native-visibility",
		entryPoint: "game",
		label: "Show/Hide Game Window",
		expectedAction: "Show or hide the native game canvas window.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	},
	{
		id: "game-native-always-on-top",
		entryPoint: "game",
		label: "Toggle Game Window Always On Top",
		expectedAction: "Toggle whether the native game window floats above other windows.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	},
	{
		id: "game-native-snapshot",
		entryPoint: "game",
		label: "Snapshot Game Window",
		expectedAction: "Capture a native snapshot of the game canvas window.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	},
	{
		id: "game-gpu-window",
		entryPoint: "game",
		label: "Launch GPU Diagnostics",
		expectedAction: "Create or focus a safe GPU diagnostics window.",
		runtimeRequirement: "desktop",
		coverage: "automated"
	}
];
function DesktopGameWindowControls({ gameWindowId }) {
	const { t } = useApp();
	const [busyAction, setBusyAction] = useState(null);
	const [message, setMessage] = useState(null);
	const [error, setError] = useState(null);
	const [alwaysOnTop, setAlwaysOnTop] = useState(false);
	const [boundsLabel, setBoundsLabel] = useState(t("gameview.BoundsUnavailable", { defaultValue: "Bounds unavailable." }));
	const [gpuWindowId, setGpuWindowId] = useState(null);
	const branding = useBranding();
	const refresh = useCallback(async () => {
		if (!gameWindowId) {
			setBoundsLabel(t("gameview.WaitingForNativeGameWindow", { defaultValue: "Waiting for native game window." }));
			setAlwaysOnTop(false);
		} else {
			const bounds = await invokeDesktopBridgeRequest({
				rpcMethod: "canvasGetBounds",
				ipcChannel: "canvas:getBounds",
				params: { id: gameWindowId }
			});
			if (bounds) setBoundsLabel(`${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`);
			try {
				const currentWindow = (await invokeDesktopBridgeRequest({
					rpcMethod: "canvasListWindows",
					ipcChannel: "canvas:listWindows"
				}))?.windows.find((item) => item.id === gameWindowId);
				setAlwaysOnTop(currentWindow?.alwaysOnTop ?? false);
			} catch (err) {
				console.warn("[GameView] Failed to refresh game window pin state", err);
			}
		}
		setGpuWindowId((await invokeDesktopBridgeRequest({
			rpcMethod: "gpuWindowList",
			ipcChannel: "gpuWindow:list"
		}))?.windows[0]?.id ?? null);
	}, [gameWindowId, t]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	const runAction = useCallback(async (id, action, successMessage, refreshAfter = true) => {
		setBusyAction(id);
		setError(null);
		setMessage(null);
		try {
			await action();
			if (refreshAfter) await refresh();
			if (successMessage) setMessage(successMessage);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("gameview.NativeGameActionFailed", { defaultValue: "Native game action failed." }));
		} finally {
			setBusyAction(null);
		}
	}, [refresh, t]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-wrap items-center gap-2",
		children: [
			(0, import_jsx_runtime.jsx)("span", {
				className: "rounded border border-border px-2 py-1 text-2xs text-muted",
				children: boundsLabel
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-refresh", async () => {}, t("gameview.NativeGameStateRefreshed", { defaultValue: "Native game state refreshed." })),
				disabled: busyAction === "game-native-refresh",
				children: t("gameview.RefreshNativeState", { defaultValue: "Refresh Native State" })
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-focus", async () => {
					if (!gameWindowId) throw new Error(t("gameview.GameWindowNotReadyYet", { defaultValue: "Game window not ready yet." }));
					await invokeDesktopBridgeRequest({
						rpcMethod: "canvasFocus",
						ipcChannel: "canvas:focus",
						params: { id: gameWindowId }
					});
				}, t("gameview.FocusedNativeGameWindow", { defaultValue: "Focused native game window." }), false),
				disabled: !gameWindowId || busyAction === "game-native-focus",
				children: t("gameview.FocusWindow", { defaultValue: "Focus Window" })
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-show", async () => {
					if (!gameWindowId) throw new Error(t("gameview.GameWindowNotReadyYet", { defaultValue: "Game window not ready yet." }));
					await invokeDesktopBridgeRequest({
						rpcMethod: "canvasShow",
						ipcChannel: "canvas:show",
						params: { id: gameWindowId }
					});
				}, t("gameview.ShownNativeGameWindow", { defaultValue: "Shown native game window." }), false),
				disabled: !gameWindowId || busyAction === "game-native-show",
				children: t("gameview.ShowWindow", { defaultValue: "Show Window" })
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-hide", async () => {
					if (!gameWindowId) throw new Error(t("gameview.GameWindowNotReadyYet", { defaultValue: "Game window not ready yet." }));
					await invokeDesktopBridgeRequest({
						rpcMethod: "canvasHide",
						ipcChannel: "canvas:hide",
						params: { id: gameWindowId }
					});
				}, t("gameview.HidNativeGameWindow", { defaultValue: "Hid native game window." }), false),
				disabled: !gameWindowId || busyAction === "game-native-hide",
				children: t("gameview.HideWindow", { defaultValue: "Hide Window" })
			}),
			(0, import_jsx_runtime.jsxs)(Button, {
				variant: alwaysOnTop ? "default" : "outline",
				size: "sm",
				className: "h-7 gap-1.5 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-always-on-top", async () => {
					if (!gameWindowId) throw new Error(t("gameview.GameWindowNotReadyYet", { defaultValue: "Game window not ready yet." }));
					const next = !alwaysOnTop;
					if (!(await invokeDesktopBridgeRequest({
						rpcMethod: "canvasSetAlwaysOnTop",
						ipcChannel: "canvas:setAlwaysOnTop",
						params: {
							id: gameWindowId,
							flag: next
						}
					}))?.success) throw new Error(t("gameview.GameWindowNoLongerOpen", { defaultValue: "Game window is no longer open." }));
					setAlwaysOnTop(next);
				}, alwaysOnTop ? t("gameview.NativeGameWindowNormal", { defaultValue: "Native game window acts like a normal window." }) : t("gameview.NativeGameWindowPinned", { defaultValue: "Native game window stays on top." })),
				disabled: !gameWindowId || busyAction === "game-native-always-on-top",
				children: [alwaysOnTop ? (0, import_jsx_runtime.jsx)(PinOff, {
					className: "h-3.5 w-3.5",
					"aria-hidden": "true"
				}) : (0, import_jsx_runtime.jsx)(Pin, {
					className: "h-3.5 w-3.5",
					"aria-hidden": "true"
				}), alwaysOnTop ? t("gameview.NormalWindow", { defaultValue: "Normal Window" }) : t("gameview.KeepOnTop", { defaultValue: "Keep On Top" })]
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-native-snapshot", async () => {
					if (!gameWindowId) throw new Error(t("gameview.GameWindowNotReadyYet", { defaultValue: "Game window not ready yet." }));
					if (!(await invokeDesktopBridgeRequest({
						rpcMethod: "canvasSnapshot",
						ipcChannel: "canvas:snapshot",
						params: {
							id: gameWindowId,
							format: "png"
						}
					}))?.data) throw new Error(t("gameview.SnapshotUnavailable", { defaultValue: "Snapshot unavailable." }));
				}, t("gameview.CapturedNativeGameSnapshot", { defaultValue: "Captured native game snapshot." }), false),
				disabled: !gameWindowId || busyAction === "game-native-snapshot",
				children: t("gameview.SnapshotWindow", { defaultValue: "Snapshot Window" })
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-gpu-window", async () => {
					const nextGpuWindowId = (await invokeDesktopBridgeRequest({
						rpcMethod: "gpuWindowCreate",
						ipcChannel: "gpuWindow:create",
						params: {
							id: "gpu-diagnostics",
							title: `${branding.appName} GPU Diagnostics`,
							width: 640,
							height: 360
						}
					}))?.id ?? gpuWindowId;
					if (nextGpuWindowId) {
						await invokeDesktopBridgeRequest({
							rpcMethod: "gpuWindowShow",
							ipcChannel: "gpuWindow:show",
							params: { id: nextGpuWindowId }
						});
						await invokeDesktopBridgeRequest({
							rpcMethod: "gpuWindowGetInfo",
							ipcChannel: "gpuWindow:getInfo",
							params: { id: nextGpuWindowId }
						});
						setGpuWindowId(nextGpuWindowId);
					}
				}, t("gameview.GpuDiagnosticsWindowReady", { defaultValue: "GPU diagnostics window ready." })),
				disabled: busyAction === "game-gpu-window",
				children: t("gameview.LaunchGpuDiagnostics", { defaultValue: "Launch GPU Diagnostics" })
			}),
			gpuWindowId && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-gpu-show", async () => {
					await invokeDesktopBridgeRequest({
						rpcMethod: "gpuWindowShow",
						ipcChannel: "gpuWindow:show",
						params: { id: gpuWindowId }
					});
				}, t("gameview.GpuDiagnosticsWindowShown", { defaultValue: "GPU diagnostics window shown." }), false),
				disabled: busyAction === "game-gpu-show",
				children: t("gameview.ShowGpuWindow", { defaultValue: "Show GPU Window" })
			}), (0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-7 text-xs shadow-sm hover:border-accent",
				onClick: () => void runAction("game-gpu-hide", async () => {
					await invokeDesktopBridgeRequest({
						rpcMethod: "gpuWindowHide",
						ipcChannel: "gpuWindow:hide",
						params: { id: gpuWindowId }
					});
				}, t("gameview.GpuDiagnosticsWindowHidden", { defaultValue: "GPU diagnostics window hidden." }), false),
				disabled: busyAction === "game-gpu-hide",
				children: t("gameview.HideGpuWindow", { defaultValue: "Hide GPU Window" })
			})] }),
			(message || error) && (0, import_jsx_runtime.jsx)("span", {
				className: `text-2xs ${error ? "text-danger" : "text-ok"}`,
				children: error ?? message
			})
		]
	});
}
function GameView() {
	const { setTimeout } = useTimeout();
	const { appRuns, activeGameRunId, activeGameApp, activeGameDisplayName, activeGameViewerUrl, activeGameSandbox, activeGamePostMessageAuth, activeGamePostMessagePayload, activeGameSession, gameOverlayEnabled, logs, logLoadError, loadLogs, setState, setActionNotice, t } = useApp();
	const isElectrobun = isElectrobunRuntime();
	const isCompactLayout = useMediaQuery("(max-width: 1023px)");
	const [stopping, setStopping] = useState(false);
	const [attachingViewer, setAttachingViewer] = useState(false);
	const [detachingViewer, setDetachingViewer] = useState(false);
	const [showLogsPanel, setShowLogsPanel] = useState(false);
	const [showDiagnostics, setShowDiagnostics] = useState(false);
	const [mobileSurface, setMobileSurface] = useState("game");
	const docVisible = useDocumentVisibility();
	const [connectionStatus, setConnectionStatus] = useState("connecting");
	const [chatInput, setChatInput] = useState("");
	const [sendingChat, setSendingChat] = useState(false);
	const [sessionBusyAction, setSessionBusyAction] = useState(null);
	const [sessionState, setSessionState] = useState(activeGameSession);
	const [gameWindowId, setGameWindowId] = useState(null);
	const gameWindowIdRef = useRef(null);
	const appRunsRef = useRef(appRuns);
	const activeGameSessionRef = useRef(activeGameSession);
	const sessionStateRef = useRef(sessionState);
	const refreshSessionPromiseRef = useRef(null);
	const iframeRef = useRef(null);
	const authSentRef = useRef(false);
	const viewerSessionRef = useRef("");
	const activeGameRun = useMemo(() => appRuns.find((run) => run.runId === activeGameRunId) ?? null, [activeGameRunId, appRuns]);
	const useEmbeddedViewer = useMemo(() => shouldUseEmbeddedAppViewer(activeGameRun), [activeGameRun]);
	const useNativeGameWindow = Boolean(isElectrobun && activeGameRun?.viewer?.url && activeGameRun.viewerAttachment === "attached" && !useEmbeddedViewer);
	const OperatorSurface = useMemo(() => getAppOperatorSurface(activeGameApp), [activeGameApp]);
	const hasOperatorSurface = Boolean(OperatorSurface);
	const openOperatorPanelByDefault = activeGameApp !== "@hyperscape/plugin-hyperscape" && activeGameApp !== "@elizaos/app-hyperscape";
	const resolvedActiveGameViewerUrl = useMemo(() => resolveEmbeddedViewerUrl(activeGameViewerUrl), [activeGameViewerUrl]);
	const resolvedActiveGameLaunchUrl = useMemo(() => resolveEmbeddedViewerUrl(activeGameRun?.launchUrl ?? ""), [activeGameRun?.launchUrl]);
	const dashboardPanelEnabled = !hasOperatorSurface || openOperatorPanelByDefault;
	const hasActiveRun = Boolean(activeGameRun);
	const hasViewer = Boolean(activeGameRun?.viewer?.url);
	const viewerAttached = activeGameRun?.viewerAttachment === "attached";
	const openableUrl = resolvedActiveGameViewerUrl || resolvedActiveGameLaunchUrl || "";
	const canAttachViewer = Boolean(activeGameRun?.viewer?.url) && activeGameRun?.viewerAttachment === "detached";
	const canDetachViewer = activeGameRun?.viewerAttachment === "attached" && (activeGameRun?.supportsViewerDetach ?? true);
	useEffect(() => {
		appRunsRef.current = appRuns;
	}, [appRuns]);
	useEffect(() => {
		activeGameSessionRef.current = activeGameSession;
	}, [activeGameSession]);
	useEffect(() => {
		sessionStateRef.current = sessionState;
	}, [sessionState]);
	const applySessionState = useCallback((nextSession) => {
		setSessionState(nextSession);
		sessionStateRef.current = nextSession;
		if (!activeGameRunId) return;
		const currentRuns = appRunsRef.current;
		const nextUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		const nextRuns = currentRuns.map((run) => {
			if (run.runId !== activeGameRunId) return run;
			const nextHealth = nextSession?.status === "disconnected" ? {
				state: "degraded",
				message: nextSession.summary ?? run.summary ?? "Session unavailable."
			} : nextSession ? {
				state: "healthy",
				message: nextSession.summary ?? null
			} : run.health;
			return {
				...run,
				session: nextSession,
				status: nextSession?.status ?? run.status,
				summary: nextSession?.summary ?? run.summary,
				updatedAt: nextUpdatedAt,
				lastHeartbeatAt: nextSession ? nextUpdatedAt : run.lastHeartbeatAt,
				health: nextHealth
			};
		});
		appRunsRef.current = nextRuns;
		setState("appRuns", nextRuns);
	}, [activeGameRunId, setState]);
	const applyRunState = useCallback((nextRun) => {
		if (!nextRun) return;
		const nextUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		setSessionState(nextRun.session ?? null);
		sessionStateRef.current = nextRun.session ?? null;
		if (nextRun.runId !== activeGameRunId) return;
		const nextRuns = appRunsRef.current.map((run) => {
			if (run.runId !== nextRun.runId) return run;
			const nextHealth = nextRun.health ?? (nextRun.session?.status === "disconnected" ? {
				state: "degraded",
				message: nextRun.session.summary ?? nextRun.summary ?? "Session unavailable."
			} : nextRun.session ? {
				state: "healthy",
				message: nextRun.session.summary ?? null
			} : run.health);
			return {
				...run,
				...nextRun,
				updatedAt: nextUpdatedAt,
				lastHeartbeatAt: nextRun.session ? nextUpdatedAt : run.lastHeartbeatAt,
				health: nextHealth
			};
		});
		appRunsRef.current = nextRuns;
		setState("appRuns", nextRuns);
	}, [activeGameRunId, setState]);
	const refreshSessionState = useCallback(async () => {
		if (refreshSessionPromiseRef.current) return refreshSessionPromiseRef.current;
		const refreshTask = (async () => {
			const currentSession = sessionStateRef.current ?? activeGameSessionRef.current;
			if (activeGameRunId) try {
				const nextRun = await client.getAppRun(activeGameRunId);
				if (nextRun) {
					applyRunState(nextRun);
					setConnectionStatus(nextRun.health.state === "offline" || nextRun.session?.status === "disconnected" ? "disconnected" : "connected");
					return nextRun.session ?? null;
				}
			} catch (err) {
				console.warn("[GameView] Failed to refresh app run state:", err);
				if (!activeGameApp || !currentSession?.sessionId) {
					setConnectionStatus("disconnected");
					return currentSession ?? null;
				}
			}
			if (!activeGameApp || !currentSession?.sessionId) return null;
			try {
				const nextSession = await client.getAppSessionState(activeGameApp, currentSession.sessionId);
				applySessionState(nextSession);
				setConnectionStatus("connected");
				return nextSession;
			} catch (err) {
				console.warn("[GameView] Failed to refresh app session state:", err);
				if (activeGameRunId) {
					setConnectionStatus("disconnected");
					return currentSession ?? null;
				}
				applySessionState(buildDisconnectedSessionState(currentSession));
				setConnectionStatus("disconnected");
				return null;
			}
		})();
		refreshSessionPromiseRef.current = refreshTask;
		try {
			return await refreshTask;
		} finally {
			if (refreshSessionPromiseRef.current === refreshTask) refreshSessionPromiseRef.current = null;
		}
	}, [
		activeGameRunId,
		activeGameApp,
		applyRunState,
		applySessionState
	]);
	useEffect(() => {
		setSessionState(activeGameSession);
		sessionStateRef.current = activeGameSession;
	}, [activeGameSession]);
	useEffect(() => {
		setShowLogsPanel(dashboardPanelEnabled);
		setMobileSurface("game");
	}, [dashboardPanelEnabled]);
	useEffect(() => {
		if (!activeGameRunId && !activeGameSession?.sessionId) return;
		refreshSessionState();
	}, [
		activeGameRunId,
		activeGameSession?.sessionId,
		refreshSessionState
	]);
	useIntervalWhenDocumentVisible(() => {
		refreshSessionState();
	}, 3e3, Boolean(activeGameRunId || activeGameSession?.sessionId));
	useIntervalWhenDocumentVisible(() => {
		if (!activeGameRunId) return;
		client.heartbeatAppRun(activeGameRunId).catch((err) => {
			if (getApiStatus$1(err) === 404) {
				setState("appRuns", appRunsRef.current.filter((run) => run.runId !== activeGameRunId));
				setState("activeGameRunId", "");
			}
		});
	}, 15e3, Boolean(activeGameRunId));
	useEffect(() => {
		if (!activeGameRunId) return;
		const handleUnload = () => {
			const beacon = navigator?.sendBeacon;
			if (typeof beacon !== "function") return;
			const baseUrl = client.getBaseUrl();
			const stopPath = `/api/apps/runs/${encodeURIComponent(activeGameRunId)}/stop`;
			const stopUrl = baseUrl ? `${baseUrl}${stopPath}` : stopPath;
			beacon.call(navigator, stopUrl);
		};
		window.addEventListener("pagehide", handleUnload);
		window.addEventListener("beforeunload", handleUnload);
		return () => {
			window.removeEventListener("pagehide", handleUnload);
			window.removeEventListener("beforeunload", handleUnload);
		};
	}, [activeGameRunId]);
	const sendChatCommand = useCallback(async (rawContent) => {
		const content = rawContent.trim();
		if (!content) return;
		const currentSession = sessionState ?? activeGameSession;
		const currentRun = activeGameRun ?? null;
		setSendingChat(true);
		try {
			if (currentRun?.runId) {
				const response = await client.sendAppRunMessage(currentRun.runId, content);
				if (response.run) applyRunState(response.run);
				else if (response.session) applySessionState(response.session);
				const notice = getSteeringNotice(response.disposition, response.message || getSteeringFallbackMessage(response.disposition, t("gameview.CommandSentToAppRun", { defaultValue: "Command sent to app run." })));
				setActionNotice(notice.text, notice.tone, notice.ttlMs);
				if (response.disposition === "accepted" || response.disposition === "queued") {
					if (!response.run && !response.session) await refreshSessionState();
					setChatInput("");
					setTimeout(() => void loadLogs(), 1500);
				}
			} else if (currentSession?.sessionId && currentSession.canSendCommands) {
				const response = await client.sendAppSessionMessage(activeGameApp, currentSession.sessionId, content);
				if (response.session) applySessionState(response.session);
				else await refreshSessionState();
				setActionNotice(response.message || t("gameview.CommandSentToAppSession", { defaultValue: "Command sent to app session." }), "success", 2400);
				setChatInput("");
				setTimeout(() => void loadLogs(), 1500);
			} else setActionNotice(t("gameview.RunSteeringUnsupported", { defaultValue: "This run does not expose a steering channel yet." }), "error", 3200);
		} catch (err) {
			const status = getApiStatus$1(err);
			setActionNotice(status === 501 || status === 503 ? t("gameview.RunSteeringUnsupported", { defaultValue: "This run does not expose a steering channel yet." }) : t("gameview.FailedToSend", {
				defaultValue: "Failed to send: {{message}}",
				message: err instanceof Error ? err.message : "error"
			}), "error", 3e3);
		} finally {
			setSendingChat(false);
		}
	}, [
		activeGameApp,
		activeGameSession,
		applySessionState,
		loadLogs,
		refreshSessionState,
		setActionNotice,
		setTimeout,
		sessionState,
		t,
		activeGameRun,
		applyRunState
	]);
	const handleSendChat = useCallback(() => {
		sendChatCommand(chatInput);
	}, [chatInput, sendChatCommand]);
	const activeSessionState = sessionState ?? activeGameSession;
	const sessionControlAction = useMemo(() => {
		if (activeSessionState?.controls?.includes("pause")) return "pause";
		if (activeSessionState?.controls?.includes("resume")) return "resume";
		return null;
	}, [activeSessionState]);
	const handleSessionControl = useCallback(async () => {
		if (!activeGameRunId || !activeGameApp || !activeGameSession?.sessionId || !sessionControlAction) return;
		setSessionBusyAction(sessionControlAction);
		try {
			const response = await client.controlAppRun(activeGameRunId, sessionControlAction);
			if (response.run) applyRunState(response.run);
			else if (response.session) applySessionState(response.session);
			const notice = getSteeringNotice(response.disposition, response.message || getSteeringFallbackMessage(response.disposition, t("gameview.SessionControlSent", { defaultValue: "Session control updated." })));
			setActionNotice(notice.text, notice.tone, notice.ttlMs);
			if ((response.disposition === "accepted" || response.disposition === "queued") && !response.run && !response.session) await refreshSessionState();
		} catch (err) {
			const status = getApiStatus$1(err);
			setActionNotice(status === 501 || status === 503 ? t("gameview.SessionControlUnsupported", { defaultValue: "This run does not expose session controls." }) : t("gameview.SessionControlFailed", {
				defaultValue: "Failed to update session: {{message}}",
				message: err instanceof Error ? err.message : "error"
			}), "error", 3200);
		} finally {
			setSessionBusyAction(null);
		}
	}, [
		activeGameApp,
		activeGameSession?.sessionId,
		applySessionState,
		refreshSessionState,
		sessionControlAction,
		setActionNotice,
		t,
		activeGameRunId,
		applyRunState
	]);
	const postMessageTargetOrigin = useMemo(() => resolvePostMessageTargetOrigin(activeGameViewerUrl), [activeGameViewerUrl]);
	const viewerSessionKey = useMemo(() => buildViewerSessionKey(activeGameViewerUrl, activeGamePostMessagePayload), [activeGamePostMessagePayload, activeGameViewerUrl]);
	const gameLogs = useMemo(() => {
		if (!activeGameApp) return [];
		const appKeyword = (packageNameToAppRouteSlug(activeGameApp) ?? activeGameApp).toLowerCase();
		return logs.filter((entry) => {
			const message = (entry.message ?? "").toLowerCase();
			const source = (entry.source ?? "").toLowerCase();
			const tags = (entry.tags ?? []).map((t) => t.toLowerCase());
			return message.includes(appKeyword) || source.includes(appKeyword) || tags.some((t) => t.includes(appKeyword)) || tags.includes("game") || tags.includes("autonomy") || source.includes("agent");
		});
	}, [activeGameApp, logs]);
	useEffect(() => {
		if (!showLogsPanel || !docVisible) return;
		loadLogs();
	}, [
		showLogsPanel,
		docVisible,
		loadLogs
	]);
	useIntervalWhenDocumentVisible(() => {
		loadLogs();
	}, 3e3, showLogsPanel);
	useEffect(() => {
		if (!useNativeGameWindow || !resolvedActiveGameViewerUrl) return;
		let cancelled = false;
		invokeDesktopBridgeRequest({
			rpcMethod: "gameOpenWindow",
			ipcChannel: "game:openWindow",
			params: {
				url: resolvedActiveGameViewerUrl,
				title: activeGameDisplayName || activeGameApp || t("common.game", { defaultValue: "Game" })
			}
		}).then((result) => {
			if (cancelled) return;
			if (result?.id) {
				gameWindowIdRef.current = result.id;
				setGameWindowId(result.id);
				setConnectionStatus("connected");
			}
		}).catch((err) => {
			console.warn("[GameView] game:openWindow failed:", err);
		});
		return () => {
			cancelled = true;
			if (gameWindowIdRef.current) {
				invokeDesktopBridgeRequest({
					rpcMethod: "canvasDestroyWindow",
					ipcChannel: "canvas:destroyWindow",
					params: { id: gameWindowIdRef.current }
				}).catch(() => {});
				gameWindowIdRef.current = null;
				setGameWindowId(null);
			}
		};
	}, [
		activeGameApp,
		activeGameDisplayName,
		resolvedActiveGameViewerUrl,
		t,
		useNativeGameWindow
	]);
	useEffect(() => {
		if (viewerSessionRef.current !== viewerSessionKey) {
			viewerSessionRef.current = viewerSessionKey;
			authSentRef.current = false;
		}
		if (activeGamePostMessageAuth && useEmbeddedViewer) {
			setConnectionStatus("connecting");
			return;
		}
		if (useNativeGameWindow) {
			setConnectionStatus("connecting");
			return;
		}
		setConnectionStatus("connected");
	}, [
		activeGamePostMessageAuth,
		useEmbeddedViewer,
		useNativeGameWindow,
		viewerSessionKey
	]);
	const resetActiveGameState = useCallback(() => {
		setSessionState(null);
		setState("activeGameRunId", "");
	}, [setState]);
	useEffect(() => {
		if (!useEmbeddedViewer || !activeGamePostMessageAuth || !activeGamePostMessagePayload) return;
		if (authSentRef.current) return;
		const expectedReadyType = resolveViewerReadyEventType(activeGamePostMessagePayload);
		if (!expectedReadyType) return;
		const onMessage = (event) => {
			if (authSentRef.current) return;
			const iframeWindow = iframeRef.current?.contentWindow;
			if (!iframeWindow || event.source !== iframeWindow) return;
			if (event.data?.type !== expectedReadyType) return;
			if (postMessageTargetOrigin !== "*" && event.origin !== postMessageTargetOrigin) return;
			iframeWindow.postMessage(activeGamePostMessagePayload, postMessageTargetOrigin);
			authSentRef.current = true;
			setConnectionStatus("connected");
			setActionNotice(t("gameview.ViewerAuthSent", { defaultValue: "Viewer auth sent." }), "info", 1800);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
		};
	}, [
		activeGamePostMessageAuth,
		activeGamePostMessagePayload,
		postMessageTargetOrigin,
		setActionNotice,
		t,
		useEmbeddedViewer
	]);
	const handleOpenInNewTab = useCallback(async () => {
		if (!openableUrl) {
			setActionNotice(t("gameview.ViewerUnavailable", { defaultValue: "No viewer or launch URL is available for this run." }), "error", 3200);
			return;
		}
		const popup = preOpenWindow();
		try {
			if (popup) navigatePreOpenedWindow(popup, openableUrl);
			else await openExternalUrl(openableUrl);
		} catch {
			setActionNotice(t("appsview.PopupBlocked", { defaultValue: "Popup blocked. Allow popups and try again." }), "error", 3600);
		}
	}, [
		openableUrl,
		setActionNotice,
		t
	]);
	const handleAttachViewer = useCallback(async () => {
		if (!activeGameRun) return;
		setAttachingViewer(true);
		try {
			const result = await client.attachAppRun(activeGameRun.runId);
			if (result.run) applyRunState(result.run);
			setActionNotice(result.message || t("gameview.ViewerAttached", { defaultValue: "Viewer attached." }), "success", 2200);
		} catch (err) {
			setActionNotice(t("gameview.ViewerAttachFailed", {
				defaultValue: "Failed to attach viewer: {{message}}",
				message: err instanceof Error ? err.message : "error"
			}), "error", 3600);
		} finally {
			setAttachingViewer(false);
		}
	}, [
		activeGameRun,
		applyRunState,
		setActionNotice,
		t
	]);
	const handleDetachViewer = useCallback(async () => {
		if (!activeGameRun) return;
		setDetachingViewer(true);
		try {
			const result = await client.detachAppRun(activeGameRun.runId);
			if (result.run) applyRunState(result.run);
			setActionNotice(result.message || t("gameview.ViewerDetached", { defaultValue: "Viewer detached." }), "success", 2200);
		} catch (err) {
			setActionNotice(t("gameview.ViewerDetachFailed", {
				defaultValue: "Failed to detach viewer: {{message}}",
				message: err instanceof Error ? err.message : "error"
			}), "error", 3600);
		} finally {
			setDetachingViewer(false);
		}
	}, [
		activeGameRun,
		applyRunState,
		setActionNotice,
		t
	]);
	const handleStop = useCallback(async () => {
		if (!activeGameRunId) return;
		setStopping(true);
		try {
			const stopResult = await client.stopAppRun(activeGameRunId);
			const nextRuns = appRuns.filter((run) => run.runId !== activeGameRunId);
			setState("appRuns", nextRuns);
			resetActiveGameState();
			setState("tab", "apps");
			setState("appsSubTab", nextRuns.length > 0 ? "running" : "browse");
			setActionNotice(stopResult.message, stopResult.success ? "success" : "info", stopResult.needsRestart ? 5e3 : 3200);
		} catch (err) {
			setActionNotice(t("gameview.FailedToStop", {
				defaultValue: "Failed to stop: {{message}}",
				message: err instanceof Error ? err.message : "error"
			}), "error");
		} finally {
			setStopping(false);
		}
	}, [
		activeGameRunId,
		appRuns,
		resetActiveGameState,
		setActionNotice,
		setState,
		t
	]);
	if (!hasActiveRun) return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center justify-center py-10 text-muted italic",
		children: [
			t("game.noActiveSession"),
			" ",
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "default",
				size: "sm",
				onClick: () => {
					setState("tab", "apps");
					setState("appsSubTab", "browse");
				},
				className: "ml-2 font-bold tracking-wide shadow-sm",
				children: t("game.backToApps")
			})
		]
	});
	const renderLogsPanel = (layout = "sidebar") => (0, import_jsx_runtime.jsxs)("div", {
		className: `flex min-h-0 flex-col bg-card ${layout === "sidebar" ? "w-80" : "h-full"}`,
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-3 py-2",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "font-bold text-xs",
						children: t("game.agentActivity")
					}),
					(0, import_jsx_runtime.jsx)("span", { className: "flex-1" }),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-6 text-2xs px-2 py-0 border-border bg-card hover:border-accent",
						onClick: () => void loadLogs(),
						children: t("common.refresh")
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-6 text-2xs px-2 py-0 border-border bg-card hover:border-accent",
						onClick: () => setShowLogsPanel(false),
						children: t("common.hide")
					})
				]
			}),
			activeSessionState?.goalLabel ? (0, import_jsx_runtime.jsx)("div", {
				className: "px-2 py-1.5 text-2xs text-muted",
				children: activeSessionState.goalLabel
			}) : null,
			activeSessionState?.telemetry?.heroClass != null ? (0, import_jsx_runtime.jsxs)("div", {
				className: "px-2 py-2 text-2xs space-y-1.5",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [
							(0, import_jsx_runtime.jsxs)("span", {
								className: "font-semibold text-txt",
								children: [
									String(activeSessionState.telemetry.heroClass).charAt(0).toUpperCase() + String(activeSessionState.telemetry.heroClass).slice(1),
									" ",
									"Lv",
									String(activeSessionState.telemetry.heroLevel ?? "?")
								]
							}),
							(0, import_jsx_runtime.jsxs)("span", {
								className: "text-muted",
								children: [String(activeSessionState.telemetry.heroLane ?? "?"), " lane"]
							}),
							activeSessionState.telemetry.heroAlive === false ? (0, import_jsx_runtime.jsx)("span", {
								className: "text-danger font-semibold",
								children: "DEAD"
							}) : null,
							activeSessionState.telemetry.autoPlay ? (0, import_jsx_runtime.jsx)("span", {
								className: "px-1 py-0.5 rounded bg-ok/15 text-ok font-semibold",
								children: "AUTO"
							}) : (0, import_jsx_runtime.jsx)("span", {
								className: "px-1 py-0.5 rounded bg-muted/15 text-muted",
								children: "MANUAL"
							})
						]
					}),
					typeof activeSessionState.telemetry.heroHp === "number" && typeof activeSessionState.telemetry.heroMaxHp === "number" && activeSessionState.telemetry.heroMaxHp > 0 ? (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "flex-1 h-1.5 bg-border rounded-full overflow-hidden",
							children: (0, import_jsx_runtime.jsx)("div", {
								className: "h-full rounded-full transition-all",
								style: {
									width: `${Math.min(100, Math.round(Number(activeSessionState.telemetry.heroHp) / Number(activeSessionState.telemetry.heroMaxHp) * 100))}%`,
									background: Number(activeSessionState.telemetry.heroHp) / Number(activeSessionState.telemetry.heroMaxHp) > .5 ? "rgb(34, 197, 94)" : Number(activeSessionState.telemetry.heroHp) / Number(activeSessionState.telemetry.heroMaxHp) > .25 ? "rgb(245, 158, 11)" : "rgb(239, 68, 68)"
								}
							})
						}), (0, import_jsx_runtime.jsxs)("span", {
							className: "text-muted whitespace-nowrap",
							children: [
								activeSessionState.telemetry.heroHp,
								"/",
								activeSessionState.telemetry.heroMaxHp
							]
						})]
					}) : null,
					activeSessionState.telemetry.strategyVersion != null ? (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-0.5 text-muted",
						children: [
							(0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center gap-2",
								children: [
									(0, import_jsx_runtime.jsxs)("span", { children: ["Strategy v", String(activeSessionState.telemetry.strategyVersion)] }),
									activeSessionState.telemetry.strategyScore != null ? (0, import_jsx_runtime.jsxs)("span", { children: [
										"score:",
										" ",
										Number(activeSessionState.telemetry.strategyScore).toFixed(2)
									] }) : null,
									activeSessionState.telemetry.bestStrategyVersion != null ? (0, import_jsx_runtime.jsxs)("span", { children: [
										"best: v",
										String(activeSessionState.telemetry.bestStrategyVersion),
										" (",
										Number(activeSessionState.telemetry.bestStrategyScore ?? 0).toFixed(2),
										")"
									] }) : null
								]
							}),
							activeSessionState.telemetry.abilityPriority ? (0, import_jsx_runtime.jsxs)("div", {
								className: "text-3xs",
								children: [
									"Priority:",
									" ",
									activeSessionState.telemetry.abilityPriority.join(" > "),
									" · ",
									"Recall @",
									Math.round(Number(activeSessionState.telemetry.recallThreshold ?? .25) * 100),
									"% HP"
								]
							}) : null,
							activeSessionState.telemetry.ticksTracked != null ? (0, import_jsx_runtime.jsxs)("div", {
								className: "text-3xs",
								children: [
									String(activeSessionState.telemetry.ticksTracked),
									" ",
									"ticks tracked ·",
									" ",
									String(activeSessionState.telemetry.abilitiesLearned ?? 0),
									" ",
									"abilities learned",
									activeSessionState.telemetry.survivalRate != null ? ` · ${Math.round(Number(activeSessionState.telemetry.survivalRate) * 100)}% survival` : ""
								]
							}) : null
						]
					}) : null,
					activeSessionState.telemetry.laneHumanUnits != null ? (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2 text-muted",
						children: [(0, import_jsx_runtime.jsx)("span", { children: "Lane:" }), (0, import_jsx_runtime.jsxs)("span", {
							className: Number(activeSessionState.telemetry.laneFrontline ?? 0) > 0 ? "text-ok" : Number(activeSessionState.telemetry.laneFrontline ?? 0) < 0 ? "text-danger" : "",
							children: [
								String(activeSessionState.telemetry.laneHumanUnits),
								"v",
								String(activeSessionState.telemetry.laneOrcUnits),
								" (",
								Number(activeSessionState.telemetry.laneFrontline ?? 0) > 0 ? "+" : "",
								String(activeSessionState.telemetry.laneFrontline),
								")"
							]
						})]
					}) : null
				]
			}) : null,
			activeSessionState?.suggestedPrompts?.length ? (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-1 px-2 py-2",
				children: activeSessionState.suggestedPrompts.slice(0, 4).map((prompt) => (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-6 max-w-full text-2xs shadow-sm",
					onClick: () => void sendChatCommand(prompt),
					disabled: sendingChat,
					children: (0, import_jsx_runtime.jsx)("span", {
						className: "truncate",
						children: prompt
					})
				}, prompt))
			}) : null,
			activeSessionState?.recommendations?.length ? (0, import_jsx_runtime.jsxs)("div", {
				className: "px-2 py-2 text-2xs space-y-1.5",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold text-txt",
					children: t("gameview.Recommendations", { defaultValue: "Recommendations" })
				}), activeSessionState.recommendations.slice(0, 3).map((item) => (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-0.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "text-txt",
						children: [item.label, typeof item.priority === "number" ? (0, import_jsx_runtime.jsxs)("span", {
							className: "ml-1 text-muted",
							children: ["#", item.priority]
						}) : null]
					}), item.reason ? (0, import_jsx_runtime.jsx)("div", {
						className: "text-muted",
						children: item.reason
					}) : null]
				}, item.id))]
			}) : null,
			logLoadError ? (0, import_jsx_runtime.jsx)("div", {
				className: "border-b border-danger/25 bg-danger/8 px-2 py-1.5 text-2xs text-danger",
				children: t("logsview.LoadFailed", {
					defaultValue: "Failed to load logs: {{message}}",
					message: logLoadError
				})
			}) : null,
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-2 py-2",
				children: [(0, import_jsx_runtime.jsx)(Input, {
					type: "text",
					"data-testid": "game-command-input",
					value: chatInput,
					onChange: (e) => setChatInput(e.target.value),
					onKeyDown: (e) => {
						if (e.key === "Enter" && !e.shiftKey && !sendingChat) {
							e.preventDefault();
							handleSendChat();
						}
					},
					placeholder: t("game.chatPlaceholder"),
					className: "flex-1 h-8 text-xs bg-bg focus-visible:ring-accent",
					disabled: sendingChat
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					"data-testid": "game-command-send",
					onClick: handleSendChat,
					disabled: sendingChat || !chatInput.trim(),
					className: "h-8 shadow-sm font-bold tracking-wide",
					children: sendingChat ? "..." : t("common.send")
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex-1 min-h-0 overflow-y-auto p-2 text-xs-tight font-mono",
				children: Array.isArray(activeSessionState?.telemetry?.recentActivity) && (activeSessionState?.telemetry).recentActivity.length > 0 ? (activeSessionState?.telemetry).recentActivity.slice().reverse().slice(0, 30).map((entry, idx) => (0, import_jsx_runtime.jsxs)("div", {
					className: "py-1 flex flex-col gap-0.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "text-muted text-2xs",
							children: formatTime(entry.ts, { fallback: "—" })
						}), (0, import_jsx_runtime.jsx)("span", {
							className: `font-semibold text-2xs uppercase ${entry.action === "error" ? "text-danger" : entry.action.startsWith("ability") ? "text-ok" : entry.action.startsWith("move") ? "text-warn" : "text-muted"}`,
							children: entry.action.split(":")[0]
						})]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "text-txt break-all",
						children: entry.detail
					})]
				}, `${entry.ts}-${idx}`)) : Array.isArray(activeSessionState?.activity) && activeSessionState.activity.length > 0 ? activeSessionState.activity.slice().sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0)).slice(0, 30).map((entry) => (0, import_jsx_runtime.jsxs)("div", {
					className: "py-1 flex flex-col gap-0.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "text-muted text-2xs",
							children: formatTime(entry.timestamp ?? 0, { fallback: "—" })
						}), (0, import_jsx_runtime.jsx)("span", {
							className: `font-semibold text-2xs uppercase ${entry.severity === "error" ? "text-danger" : entry.severity === "warning" ? "text-warn" : "text-muted"}`,
							children: entry.type
						})]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "text-txt break-all",
						children: entry.message
					})]
				}, entry.id)) : gameLogs.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-center py-4 text-muted italic",
					children: t("game.noAgentActivity")
				}) : gameLogs.slice(0, 50).map((entry, idx) => (0, import_jsx_runtime.jsxs)("div", {
					className: "py-1 flex flex-col gap-0.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1",
						children: [
							(0, import_jsx_runtime.jsx)("span", {
								className: "text-muted text-2xs",
								children: formatTime(entry.timestamp, { fallback: "—" })
							}),
							(0, import_jsx_runtime.jsx)("span", {
								className: `font-semibold text-2xs uppercase ${entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-warn" : "text-muted"}`,
								children: entry.level
							}),
							(entry.tags ?? []).slice(0, 2).map((t) => {
								const c = TAG_COLORS[t];
								return (0, import_jsx_runtime.jsx)("span", {
									className: "text-3xs px-1 py-px rounded",
									style: {
										background: c ? c.bg : "var(--bg-muted)",
										color: c ? c.fg : "var(--muted)"
									},
									children: t
								}, t);
							})
						]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "text-txt break-all",
						children: entry.message
					})]
				}, `${entry.timestamp}-${idx}`))
			})
		]
	});
	const activeRunSummary = activeGameRun?.summary ?? activeGameRun?.health.message ?? activeSessionState?.summary ?? null;
	const gameStatusLabel = connectionStatus !== "connected" ? connectionStatus === "connecting" ? "Starting" : "Offline" : activeGameRun?.health.state === "offline" || activeGameRun?.health.state === "degraded" ? "Needs attention" : "Live";
	const gameStatusClass = gameStatusLabel === "Live" ? "border-ok/30 bg-ok/10 text-ok" : gameStatusLabel === "Needs attention" ? "border-warn/35 bg-warn/10 text-warn" : "border-border/45 bg-bg-hover/70 text-muted-strong";
	const diagnostics = [
		{
			label: "Connection",
			value: connectionStatus
		},
		{
			label: "Viewer",
			value: activeGameRun?.viewerAttachment ?? "unavailable"
		},
		{
			label: "Health",
			value: activeGameRun?.health.state ?? "unknown"
		},
		{
			label: "Chat",
			value: activeGameRun?.chatAvailability ?? "unknown"
		},
		{
			label: "Control",
			value: activeGameRun?.controlAvailability ?? "unknown"
		}
	];
	const operatorSurfaceFocus = isCompactLayout && mobileSurface === "dashboard" ? "dashboard" : isCompactLayout && mobileSurface === "chat" ? "chat" : "all";
	const openInNewTabLabel = hasViewer ? t("game.openInNewTab") : "Open launch URL";
	const renderOpenInNewTabButton = (variant, className) => {
		if (!openableUrl || isElectrobun) return (0, import_jsx_runtime.jsx)(Button, {
			variant,
			size: "sm",
			className,
			onClick: handleOpenInNewTab,
			disabled: !openableUrl,
			children: openInNewTabLabel
		});
		return (0, import_jsx_runtime.jsx)(Button, {
			asChild: true,
			variant,
			size: "sm",
			className,
			children: (0, import_jsx_runtime.jsx)("a", {
				href: openableUrl,
				target: "_blank",
				rel: "noreferrer",
				children: openInNewTabLabel
			})
		});
	};
	const renderViewerPane = () => {
		if (!hasViewer) return (0, import_jsx_runtime.jsxs)("div", {
			className: "flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "text-sm font-semibold text-txt",
				children: activeGameDisplayName || activeGameApp
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "max-w-md text-xs leading-6 text-muted",
				children: "This run is alive, but it does not currently expose a viewer URL. You can keep steering it from the dashboard and running-runs panel."
			})]
		});
		if (!viewerAttached) return (0, import_jsx_runtime.jsxs)("div", {
			className: "flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-sm font-semibold text-txt",
					children: "Viewer detached"
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "max-w-md text-xs leading-6 text-muted",
					children: "The autonomous run is still active. Reattach the viewer to resume watching without restarting the session."
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-wrap justify-center gap-2",
					children: renderOpenInNewTabButton("outline")
				})
			]
		});
		if (useNativeGameWindow) return (0, import_jsx_runtime.jsx)("div", {
			className: "w-full h-full flex flex-col items-center justify-center bg-bg text-muted gap-3",
			children: gameWindowId ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("span", {
				className: "text-sm font-semibold text-txt",
				children: activeGameDisplayName || activeGameApp
			}), (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs text-muted",
				children: t("game.openInNativeWindow")
			})] }) : (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs italic",
				children: t("common.launching")
			})
		});
		return (0, import_jsx_runtime.jsx)("iframe", {
			ref: iframeRef,
			src: resolvedActiveGameViewerUrl,
			sandbox: activeGameSandbox,
			allow: "fullscreen *",
			allowFullScreen: true,
			"data-testid": "game-view-iframe",
			className: "w-full h-full border-none",
			title: activeGameDisplayName || t("common.game", { defaultValue: "Game" })
		});
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col h-full min-h-0",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-3 bg-card px-4 py-2",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0 flex-1",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "font-bold text-sm",
								children: activeGameDisplayName || activeGameApp
							}), (0, import_jsx_runtime.jsx)("span", {
								className: `rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${gameStatusClass}`,
								children: gameStatusLabel
							})]
						}), activeRunSummary ? (0, import_jsx_runtime.jsx)("div", {
							className: "mt-1 max-w-3xl truncate text-xs-tight leading-5 text-muted-strong",
							children: activeRunSummary
						}) : null]
					}),
					sessionControlAction ? (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						"data-testid": "game-session-control",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => void handleSessionControl(),
						disabled: sessionBusyAction === sessionControlAction,
						children: sessionBusyAction === sessionControlAction ? t("gameview.UpdatingSession", { defaultValue: "Updating…" }) : sessionControlAction === "pause" ? t("common.pause", { defaultValue: "Pause" }) : t("common.resume", { defaultValue: "Resume" })
					}) : null,
					dashboardPanelEnabled && !isCompactLayout ? (0, import_jsx_runtime.jsx)(Button, {
						variant: showLogsPanel ? "default" : "outline",
						size: "sm",
						"data-testid": "game-toggle-logs",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => setShowLogsPanel(!showLogsPanel),
						children: showLogsPanel ? "Hide game chat" : "Show game chat"
					}) : null,
					(0, import_jsx_runtime.jsx)(Button, {
						variant: showDiagnostics ? "default" : "outline",
						size: "sm",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => setShowDiagnostics((current) => !current),
						children: "Details"
					}),
					canAttachViewer ? (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => void handleAttachViewer(),
						disabled: attachingViewer,
						children: attachingViewer ? "Reattaching..." : "Reattach viewer"
					}) : null,
					canDetachViewer ? (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => void handleDetachViewer(),
						disabled: detachingViewer,
						children: detachingViewer ? "Detaching..." : "Detach viewer"
					}) : null,
					useNativeGameWindow ? (0, import_jsx_runtime.jsx)(DesktopGameWindowControls, { gameWindowId }) : null,
					hasViewer ? (0, import_jsx_runtime.jsx)(Button, {
						variant: gameOverlayEnabled ? "default" : "outline",
						size: "sm",
						className: "h-7 text-xs shadow-sm hover:border-accent",
						onClick: () => setState("gameOverlayEnabled", !gameOverlayEnabled),
						title: gameOverlayEnabled ? t("game.disableOverlay") : t("game.keepVisible"),
						children: gameOverlayEnabled ? t("game.unpinOverlay") : t("game.keepOnTop")
					}) : null,
					renderOpenInNewTabButton("default", "h-7 text-xs shadow-sm"),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-7 text-xs shadow-sm",
						disabled: stopping,
						onClick: handleStop,
						children: stopping ? t("game.stopping") : t("common.stop")
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-7 text-xs shadow-sm",
						onClick: () => {
							setState("tab", "apps");
							setState("appsSubTab", "browse");
						},
						children: t("game.backToApps")
					})
				]
			}),
			showDiagnostics ? (0, import_jsx_runtime.jsxs)("div", {
				className: "border-t border-border/30 bg-card/70 px-4 py-2 text-xs-tight leading-5 text-muted-strong",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap gap-2",
					children: [diagnostics.map((item) => (0, import_jsx_runtime.jsxs)("span", {
						className: "rounded-full border border-border/35 bg-bg/65 px-2.5 py-1",
						children: [(0, import_jsx_runtime.jsxs)("span", {
							className: "text-muted",
							children: [item.label, ": "]
						}), item.value]
					}, item.label)), activeGamePostMessageAuth ? (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-full border border-border/35 bg-bg/65 px-2.5 py-1",
						children: t("gameview.postMessageAuth")
					}) : null]
				}), activeGameRun?.health.message ? (0, import_jsx_runtime.jsx)("div", {
					className: "mt-2",
					children: activeGameRun.health.message
				}) : null]
			}) : null,
			dashboardPanelEnabled && isCompactLayout ? (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 bg-card px-4 py-2",
				children: [
					(0, import_jsx_runtime.jsx)(Button, {
						variant: mobileSurface === "game" ? "default" : "outline",
						size: "sm",
						"data-testid": "game-mobile-surface-game",
						className: "h-8 text-xs shadow-sm",
						onClick: () => setMobileSurface("game"),
						children: t("common.game", { defaultValue: "Game" })
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: mobileSurface === "dashboard" ? "default" : "outline",
						size: "sm",
						"data-testid": "game-mobile-surface-dashboard",
						className: "h-8 text-xs shadow-sm",
						onClick: () => setMobileSurface("dashboard"),
						children: t("common.actions", { defaultValue: "Actions" })
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: mobileSurface === "chat" ? "default" : "outline",
						size: "sm",
						"data-testid": "game-mobile-surface-chat",
						className: "h-8 text-xs shadow-sm",
						onClick: () => setMobileSurface("chat"),
						children: t("nav.chat", { defaultValue: "Chat" })
					})
				]
			}) : null,
			(0, import_jsx_runtime.jsxs)("div", {
				className: `flex-1 min-h-0 ${isCompactLayout ? "flex flex-col" : "flex"}`,
				children: [!dashboardPanelEnabled || !isCompactLayout || mobileSurface === "game" ? (0, import_jsx_runtime.jsx)("div", {
					className: "flex-1 min-h-0 relative",
					children: renderViewerPane()
				}) : null, showLogsPanel && dashboardPanelEnabled || isCompactLayout && dashboardPanelEnabled && mobileSurface !== "game" ? isCompactLayout ? mobileSurface === "dashboard" || mobileSurface === "chat" ? hasOperatorSurface && OperatorSurface ? (0, import_jsx_runtime.jsx)("div", {
					className: "h-full overflow-y-auto",
					children: (0, import_jsx_runtime.jsx)(OperatorSurface, {
						appName: activeGameApp,
						variant: "live",
						focus: operatorSurfaceFocus
					})
				}) : renderLogsPanel("standalone") : null : hasOperatorSurface && OperatorSurface ? (0, import_jsx_runtime.jsx)("div", {
					className: "w-[30rem] min-h-0 overflow-y-auto bg-card",
					children: (0, import_jsx_runtime.jsx)(OperatorSurface, {
						appName: activeGameApp,
						variant: "live",
						focus: "all"
					})
				}) : renderLogsPanel() : null]
			})
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/AppsCatalogGrid.js
const CARD_GAP_PX = 8;
const MAX_CARDS_PER_ROW = 5;
const MIN_CARD_WIDTH_PX = 248;
function clampCardsPerRow(value) {
	return Math.min(Math.max(value, 1), MAX_CARDS_PER_ROW);
}
function resolveCardsPerRow(width) {
	if (width <= 0) return MAX_CARDS_PER_ROW;
	return clampCardsPerRow(Math.floor((width + CARD_GAP_PX) / (MIN_CARD_WIDTH_PX + CARD_GAP_PX)));
}
function buildBalancedRows(items, maxCardsPerRow) {
	if (items.length === 0) return [];
	const perRow = clampCardsPerRow(maxCardsPerRow);
	if (items.length <= perRow) return [[...items]];
	const rowCount = Math.ceil(items.length / perRow);
	const baseRowSize = Math.floor(items.length / rowCount);
	const oversizedRowCount = items.length % rowCount;
	const rows = [];
	let index = 0;
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
		const size = rowIndex < rowCount - oversizedRowCount ? baseRowSize : baseRowSize + 1;
		rows.push(items.slice(index, index + size));
		index += size;
	}
	return rows;
}
function resolveSectionPreferredSlots(itemCount, maxCardsPerRow) {
	return clampCardsPerRow(Math.min(Math.max(itemCount, 1), maxCardsPerRow));
}
function resolveSectionMinSlots(itemCount, maxCardsPerRow) {
	const preferredSlots = resolveSectionPreferredSlots(itemCount, maxCardsPerRow);
	if (itemCount <= 3 || preferredSlots <= 2) return preferredSlots;
	return Math.max(2, preferredSlots - 1);
}
function buildCatalogSectionRows(sections, maxCardsPerRow) {
	if (sections.length === 0) return [];
	const rowCapacity = clampCardsPerRow(maxCardsPerRow);
	const rows = [];
	let sectionIndex = 0;
	while (sectionIndex < sections.length) {
		const rowSections = [];
		let usedSlots = 0;
		while (sectionIndex < sections.length) {
			const section = sections[sectionIndex];
			const preferredSlots = resolveSectionPreferredSlots(section.apps.length, rowCapacity);
			const minSlots = resolveSectionMinSlots(section.apps.length, rowCapacity);
			const remainingSlots = rowCapacity - usedSlots;
			if (remainingSlots <= 0) break;
			let slots = preferredSlots;
			if (usedSlots === 0) {
				const nextSection = sections[sectionIndex + 1];
				if (nextSection && preferredSlots === rowCapacity && minSlots < preferredSlots) {
					if (minSlots + resolveSectionMinSlots(nextSection.apps.length, rowCapacity) <= rowCapacity) slots = minSlots;
				}
			} else if (preferredSlots > remainingSlots) {
				const leadSection = rowSections[0];
				if (rowSections.length === 1 && leadSection?.key === "favorites" && leadSection.apps.length <= 2 && section.key === "featured" && remainingSlots >= 2) slots = remainingSlots;
				else if (minSlots <= remainingSlots) slots = minSlots;
				else break;
			}
			if (slots > remainingSlots) {
				if (rowSections.length > 0) break;
				slots = remainingSlots;
			}
			rowSections.push({
				...section,
				slots
			});
			usedSlots += slots;
			sectionIndex += 1;
			if (usedSlots >= rowCapacity) break;
		}
		if (rowSections.length === 0) {
			const section = sections[sectionIndex];
			rowSections.push({
				...section,
				slots: resolveSectionPreferredSlots(section.apps.length, rowCapacity)
			});
			sectionIndex += 1;
		}
		rows.push({
			sections: rowSections,
			totalSlots: rowSections.reduce((total, section) => total + section.slots, 0)
		});
	}
	return rows;
}
function CatalogSkeletonSection({ label, rowSizes }) {
	const rowDescriptors = useMemo(() => {
		const seenRowCounts = /* @__PURE__ */ new Map();
		return rowSizes.map((rowSize) => {
			const occurrence = (seenRowCounts.get(rowSize) ?? 0) + 1;
			seenRowCounts.set(rowSize, occurrence);
			const key = `${label}-${rowSize}-${occurrence}`;
			return {
				key,
				rowSize,
				cardKeys: Array.from({ length: rowSize }, (_, position) => `${key}-${position + 1}`)
			};
		});
	}, [label, rowSizes]);
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "space-y-3",
		"aria-hidden": "true",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-3",
			children: [(0, import_jsx_runtime.jsx)(Skeleton, { className: "h-3 w-28 rounded-full bg-bg-accent/80" }), (0, import_jsx_runtime.jsx)("div", { className: "h-px flex-1 bg-border/30" })]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "space-y-2",
			children: rowDescriptors.map((rowDescriptor) => (0, import_jsx_runtime.jsx)("div", {
				className: "grid gap-2",
				style: { gridTemplateColumns: `repeat(${rowDescriptor.rowSize}, minmax(0, 1fr))` },
				children: rowDescriptor.cardKeys.map((cardKey) => (0, import_jsx_runtime.jsxs)("div", {
					className: "overflow-hidden rounded-2xl border border-border/35 bg-card/72",
					children: [(0, import_jsx_runtime.jsx)(Skeleton, { className: "aspect-[4/3] w-full rounded-none bg-bg-accent/70" }), (0, import_jsx_runtime.jsx)("div", {
						className: "space-y-2 px-3 py-3",
						children: (0, import_jsx_runtime.jsx)(Skeleton, { className: "h-3 w-2/3 rounded-full bg-bg-accent/80" })
					})]
				}, cardKey))
			}, rowDescriptor.key))
		})]
	});
}
function AppsCatalogGrid({ activeAppNames, error, favoriteAppNames, loading, searchQuery, visibleApps, onLaunch, onToggleFavorite }) {
	const { t } = useApp();
	const catalogRef = useRef(null);
	const [catalogWidth, setCatalogWidth] = useState(0);
	const cardsPerRow = useMemo(() => resolveCardsPerRow(catalogWidth), [catalogWidth]);
	const sections = useMemo(() => {
		return groupAppsForCatalog(visibleApps, { favoriteAppNames });
	}, [favoriteAppNames, visibleApps]);
	const sectionRows = useMemo(() => buildCatalogSectionRows(sections, cardsPerRow), [cardsPerRow, sections]);
	useEffect(() => {
		const element = catalogRef.current;
		if (!element) return;
		const updateWidth = (width) => {
			setCatalogWidth(Math.max(0, Math.round(width)));
		};
		updateWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const nextWidth = entries[0]?.contentRect.width;
			if (typeof nextWidth === "number") updateWidth(nextWidth);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (0, import_jsx_runtime.jsxs)("div", {
		ref: catalogRef,
		"data-testid": "apps-catalog-grid",
		children: [error ? (0, import_jsx_runtime.jsx)("div", {
			className: "mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs-tight text-danger",
			children: error
		}) : null, loading ? (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-6",
			role: "status",
			"aria-label": t("appsview.Loading"),
			children: [
				(0, import_jsx_runtime.jsx)(CatalogSkeletonSection, {
					label: "Featured",
					rowSizes: [1]
				}),
				(0, import_jsx_runtime.jsx)(CatalogSkeletonSection, {
					label: "Games & Entertainment",
					rowSizes: buildBalancedRows(Array.from({ length: 7 }), cardsPerRow).map((row) => row.length)
				}),
				(0, import_jsx_runtime.jsx)(CatalogSkeletonSection, {
					label: "Developer Utilities",
					rowSizes: buildBalancedRows(Array.from({ length: 6 }), cardsPerRow).map((row) => row.length)
				})
			]
		}) : visibleApps.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
			className: "rounded-2xl border border-dashed border-border/35 bg-card/72 px-6 py-16 text-center",
			children: (0, import_jsx_runtime.jsx)("div", {
				className: "text-xs font-medium text-muted-strong",
				children: searchQuery ? t("appsview.NoAppsMatchSearch") : t("appsview.NoAppsAvailable")
			})
		}) : (0, import_jsx_runtime.jsx)("div", {
			className: "space-y-4",
			children: sectionRows.map((sectionRow) => {
				const rowKey = sectionRow.sections.map((section) => section.key).join("-");
				return (0, import_jsx_runtime.jsx)("div", {
					"data-testid": `apps-section-row-${rowKey}`,
					className: "grid gap-4",
					style: { gridTemplateColumns: `repeat(${sectionRow.totalSlots}, minmax(0, 1fr))` },
					children: sectionRow.sections.map((section) => (0, import_jsx_runtime.jsxs)("section", {
						"data-testid": `apps-section-${section.key}`,
						className: "min-w-0 space-y-3",
						style: { gridColumn: `span ${section.slots} / span ${section.slots}` },
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-3",
							children: [(0, import_jsx_runtime.jsx)("h2", {
								className: "text-sm font-semibold text-muted-strong",
								children: section.label
							}), (0, import_jsx_runtime.jsx)("div", { className: "h-px flex-1 bg-border/30" })]
						}), (0, import_jsx_runtime.jsx)("div", {
							className: "space-y-2",
							children: buildBalancedRows(section.apps, section.slots).map((row) => {
								const sectionRowKey = row.map((app) => app.name).join("-");
								return (0, import_jsx_runtime.jsx)("div", {
									className: "grid gap-2",
									style: { gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` },
									children: row.map((app) => {
										const isActive = activeAppNames.has(app.name);
										const isFavorite = favoriteAppNames.has(app.name);
										const displayName = app.displayName ?? getAppShortName(app);
										return (0, import_jsx_runtime.jsxs)("div", {
											className: `group relative overflow-hidden rounded-2xl border bg-card/72 transition-all hover:border-accent/45 focus-within:ring-2 focus-within:ring-accent/35 ${isActive ? "border-ok/45 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]" : "border-border/35 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)]"}`,
											children: [
												(0, import_jsx_runtime.jsxs)("button", {
													type: "button",
													"data-testid": `app-card-${app.name.replace(/[^a-z0-9]+/gi, "-")}`,
													title: displayName,
													"aria-label": displayName,
													className: "block w-full text-left focus-visible:outline-none",
													onClick: () => onLaunch(app),
													children: [(0, import_jsx_runtime.jsx)(AppHero, {
														app,
														className: "aspect-[4/3] transition-transform duration-300 group-hover:scale-[1.02]"
													}), (0, import_jsx_runtime.jsx)("div", {
														className: "pointer-events-none absolute inset-x-0 bottom-0 flex items-end p-2 pe-10",
														children: (0, import_jsx_runtime.jsx)("div", {
															className: "min-w-0 flex-1",
															children: (0, import_jsx_runtime.jsx)("div", {
																className: "truncate text-xs font-semibold text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]",
																children: displayName
															})
														})
													})]
												}),
												isActive ? (0, import_jsx_runtime.jsx)("span", {
													title: "Running",
													className: "pointer-events-none absolute right-4 top-4 h-2.5 w-2.5 rounded-full bg-ok shadow-[0_0_0_3px_rgba(16,185,129,0.35)]"
												}) : null,
												(0, import_jsx_runtime.jsx)("button", {
													type: "button",
													"aria-label": isFavorite ? "Remove from favorites" : "Add to favorites",
													className: `absolute bottom-3 right-3 rounded-full p-1.5 text-white transition-all ${isFavorite ? "bg-black/30 text-warn backdrop-blur-sm" : "bg-black/30 text-white/70 backdrop-blur-sm hover:text-warn focus-visible:text-warn"}`,
													onClick: (event) => {
														event.stopPropagation();
														onToggleFavorite(app.name);
													},
													children: (0, import_jsx_runtime.jsxs)("svg", {
														width: "14",
														height: "14",
														viewBox: "0 0 24 24",
														fill: isFavorite ? "currentColor" : "none",
														stroke: "currentColor",
														strokeWidth: "2",
														strokeLinecap: "round",
														strokeLinejoin: "round",
														"aria-hidden": "true",
														children: [(0, import_jsx_runtime.jsx)("title", { children: "Favorite" }), (0, import_jsx_runtime.jsx)("polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" })]
													})
												})
											]
										}, app.name);
									})
								}, `${section.key}-${sectionRowKey}`);
							})
						})]
					}, section.key))
				}, rowKey);
			})
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/AppsSidebar.js
const GENRE_ORDER = [
	"games",
	"finance",
	"developerUtilities",
	"other"
];
function AppsSidebar({ apps, browseApps, runs, activeAppNames, favoriteAppNames, selectedAppName, collapsed, onCollapsedChange, width, onWidthChange, minWidth = 220, maxWidth = 420, onLaunchApp, onOpenRun }) {
	const appsByName = useMemo(() => {
		const map = /* @__PURE__ */ new Map();
		for (const app of apps) map.set(app.name, app);
		return map;
	}, [apps]);
	const featuredEntries = useMemo(() => {
		return browseApps.filter((app) => getAppCatalogSectionKey(app) === "featured" && !favoriteAppNames.has(app.name));
	}, [browseApps, favoriteAppNames]);
	const starredEntries = useMemo(() => {
		return browseApps.filter((app) => favoriteAppNames.has(app.name)).sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
	}, [browseApps, favoriteAppNames]);
	const activeEntries = useMemo(() => {
		return runs.map((run) => {
			const app = appsByName.get(run.appName);
			return {
				run,
				app,
				displayName: app?.displayName ?? run.displayName ?? run.appName
			};
		}).sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
	}, [appsByName, runs]);
	const featuredAppNames = useMemo(() => {
		return new Set(featuredEntries.map((app) => app.name));
	}, [featuredEntries]);
	const surfacedAppNames = useMemo(() => {
		const set = /* @__PURE__ */ new Set();
		for (const appName of featuredAppNames) set.add(appName);
		for (const app of starredEntries) set.add(app.name);
		for (const entry of activeEntries) set.add(entry.run.appName);
		return set;
	}, [
		activeEntries,
		featuredAppNames,
		starredEntries
	]);
	const genreEntries = useMemo(() => {
		const buckets = /* @__PURE__ */ new Map();
		for (const app of browseApps) {
			if (surfacedAppNames.has(app.name)) continue;
			const key = getAppCatalogSectionKey(app);
			const list = buckets.get(key) ?? [];
			list.push(app);
			buckets.set(key, list);
		}
		for (const list of buckets.values()) list.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
		return GENRE_ORDER.flatMap((key) => {
			const list = buckets.get(key) ?? [];
			if (list.length === 0) return [];
			return [{
				key,
				label: APP_CATALOG_SECTION_LABELS[key],
				apps: list
			}];
		});
	}, [browseApps, surfacedAppNames]);
	return (0, import_jsx_runtime.jsx)(AppPageSidebar, {
		testId: "apps-sidebar",
		collapsible: true,
		contentIdentity: "apps",
		collapseButtonAriaLabel: "Collapse apps sidebar",
		expandButtonAriaLabel: "Expand apps sidebar",
		expandButtonTestId: "apps-sidebar-expand-toggle",
		collapsed,
		onCollapsedChange,
		resizable: true,
		width,
		onWidthChange,
		minWidth,
		maxWidth,
		onCollapseRequest: () => onCollapsedChange(true),
		children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, {
			className: "scrollbar-hide px-1 pb-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
			children: (0, import_jsx_runtime.jsx)(SidebarPanel, {
				className: "bg-transparent gap-0 p-0 shadow-none",
				children: !(featuredEntries.length > 0 || starredEntries.length > 0 || activeEntries.length > 0 || genreEntries.length > 0) ? (0, import_jsx_runtime.jsx)("div", {
					className: "px-3 py-4 text-2xs text-muted/70",
					children: "No apps available"
				}) : (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-3",
					children: [
						starredEntries.length > 0 && (0, import_jsx_runtime.jsx)(AppsSidebarSection, {
							label: "Starred",
							icon: (0, import_jsx_runtime.jsx)(Star, {
								className: "h-3 w-3",
								"aria-hidden": true
							}),
							children: starredEntries.map((app) => (0, import_jsx_runtime.jsx)(AppsSidebarAppButton, {
								name: app.name,
								displayName: app.displayName ?? getAppShortName(app),
								active: activeAppNames.has(app.name),
								selected: selectedAppName === app.name,
								identitySource: app,
								onClick: () => onLaunchApp(app)
							}, app.name))
						}),
						featuredEntries.length > 0 && (0, import_jsx_runtime.jsx)(AppsSidebarSection, {
							label: "Featured",
							icon: (0, import_jsx_runtime.jsx)(Star, {
								className: "h-3 w-3",
								"aria-hidden": true
							}),
							children: featuredEntries.map((app) => (0, import_jsx_runtime.jsx)(AppsSidebarAppButton, {
								name: app.name,
								displayName: app.displayName ?? getAppShortName(app),
								active: activeAppNames.has(app.name),
								selected: selectedAppName === app.name,
								identitySource: app,
								onClick: () => onLaunchApp(app)
							}, app.name))
						}),
						activeEntries.length > 0 && (0, import_jsx_runtime.jsx)(AppsSidebarSection, {
							label: "Active",
							icon: (0, import_jsx_runtime.jsx)(Play, {
								className: "h-3 w-3",
								"aria-hidden": true
							}),
							children: activeEntries.map(({ run, app, displayName }) => (0, import_jsx_runtime.jsx)(AppsSidebarAppButton, {
								name: run.appName,
								displayName,
								active: true,
								selected: selectedAppName === run.appName,
								identitySource: app ?? {
									name: run.appName,
									displayName,
									icon: null,
									category: "",
									description: ""
								},
								onClick: () => onOpenRun(run)
							}, run.runId))
						}),
						genreEntries.map((section) => (0, import_jsx_runtime.jsx)(AppsSidebarSection, {
							label: section.label,
							children: section.apps.map((app) => (0, import_jsx_runtime.jsx)(AppsSidebarAppButton, {
								name: app.name,
								displayName: app.displayName ?? getAppShortName(app),
								active: activeAppNames.has(app.name),
								selected: selectedAppName === app.name,
								identitySource: app,
								onClick: () => onLaunchApp(app)
							}, app.name))
						}, section.key))
					]
				})
			})
		})
	});
}
function AppsSidebarSection({ label, icon, children }) {
	return (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsxs)(SidebarContent.SectionLabel, {
		className: "mb-1 inline-flex items-center gap-1.5 px-2 text-[0.625rem]",
		children: [icon, label]
	}), (0, import_jsx_runtime.jsx)("div", {
		className: "space-y-0.5 pl-3",
		children
	})] });
}
function AppsSidebarAppButton({ displayName, active, selected, identitySource, onClick }) {
	const { t } = useTranslation();
	const Icon = getAppCategoryIcon(identitySource);
	return (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		onClick,
		"aria-current": selected ? "page" : void 0,
		className: `group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left transition-colors ${selected ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50"}`,
		children: [
			(0, import_jsx_runtime.jsx)(Icon, {
				className: "h-3.5 w-3.5 shrink-0 text-muted/70",
				"aria-hidden": true,
				strokeWidth: 2
			}),
			(0, import_jsx_runtime.jsx)("span", {
				className: "min-w-0 flex-1 truncate text-xs-tight",
				children: displayName
			}),
			active ? (0, import_jsx_runtime.jsx)("span", {
				role: "img",
				"aria-label": t("appsview.Running"),
				className: "h-1.5 w-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
			}) : null
		]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/RunningAppsRow.js
function getHealthTone(state) {
	if (state === "healthy") return {
		dot: "bg-ok",
		ring: "shadow-[0_0_0_3px_rgba(16,185,129,0.35)]"
	};
	if (state === "degraded") return {
		dot: "bg-warn",
		ring: "shadow-[0_0_0_3px_rgba(245,158,11,0.35)]"
	};
	return {
		dot: "bg-danger",
		ring: "shadow-[0_0_0_3px_rgba(239,68,68,0.35)]"
	};
}
function RunningAppsRow({ runs, catalogApps, busyRunId, onOpenRun, onStopRun, stoppingRunId }) {
	if (runs.length === 0) return null;
	const catalogAppByName = new Map(catalogApps.map((app) => [app.name, app]));
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": "running-apps-row",
		className: "space-y-3",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-3",
			children: [(0, import_jsx_runtime.jsx)("h2", {
				className: "text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent",
				children: "Running"
			}), (0, import_jsx_runtime.jsx)("div", { className: "h-px flex-1 bg-border/30" })]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
			children: runs.map((run) => {
				const app = catalogAppByName.get(run.appName) ?? {
					name: run.appName,
					displayName: run.displayName,
					category: "utility",
					icon: null
				};
				const attentionReasons = getRunAttentionReasons(run);
				const needsAttention = attentionReasons.length > 0;
				const isBusy = busyRunId === run.runId;
				const isStopping = stoppingRunId === run.runId;
				const tone = getHealthTone(run.health.state);
				return (0, import_jsx_runtime.jsxs)("div", {
					"data-testid": `running-app-card-${run.runId}`,
					className: "group relative overflow-hidden rounded-2xl border border-accent/35 bg-card/72 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)] transition-all hover:border-accent/55 focus-within:ring-2 focus-within:ring-accent/35",
					children: [
						(0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							"aria-label": `Open ${run.displayName}`,
							"aria-busy": isBusy || void 0,
							className: "block w-full text-left focus-visible:outline-none",
							onClick: () => onOpenRun(run),
							children: [(0, import_jsx_runtime.jsx)(AppHero, {
								app,
								className: "aspect-[5/4] transition-transform duration-300 group-hover:scale-[1.02]"
							}), (0, import_jsx_runtime.jsx)("div", {
								className: "pointer-events-none absolute inset-x-0 bottom-0 flex items-end p-4 pe-12",
								children: (0, import_jsx_runtime.jsx)("div", {
									className: "min-w-0 flex-1",
									children: (0, import_jsx_runtime.jsx)("div", {
										className: "truncate text-sm font-semibold text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]",
										children: run.displayName
									})
								})
							})]
						}),
						(0, import_jsx_runtime.jsx)("span", {
							title: needsAttention ? attentionReasons[0] : run.health.state,
							className: `pointer-events-none absolute right-4 top-4 h-2.5 w-2.5 rounded-full ${tone.dot} ${tone.ring}`
						}),
						needsAttention ? (0, import_jsx_runtime.jsx)("span", {
							title: attentionReasons[0],
							className: "pointer-events-none absolute right-10 top-3.5 inline-flex items-center rounded-full border border-warn/40 bg-black/40 px-2 py-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.2em] text-warn backdrop-blur-sm",
							children: "!"
						}) : null,
						onStopRun ? (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							"data-testid": `running-app-stop-${run.runId}`,
							"aria-label": `Stop ${run.displayName}`,
							disabled: isStopping,
							className: "absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-sm transition-all hover:bg-danger/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50",
							onClick: (event) => {
								event.stopPropagation();
								onStopRun(run);
							},
							children: isStopping ? (0, import_jsx_runtime.jsx)("span", { className: "h-2 w-2 animate-pulse rounded-full bg-white" }) : (0, import_jsx_runtime.jsx)(Square, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						}) : null
					]
				}, run.runId);
			})
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/launch-history.js
/**
* Ring buffer of recent app launch attempts for the App Details diagnostics
* panel. Persisted to localStorage as a single array — capped at MAX entries.
*/
const KEY = "eliza:apps:launch-history";
const MAX = 20;
function isDiagnostic(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.message === "string" && (candidate.severity === "info" || candidate.severity === "warning" || candidate.severity === "error");
}
function isRecord(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	if (typeof candidate.timestamp !== "number") return false;
	if (typeof candidate.appName !== "string") return false;
	if (typeof candidate.succeeded !== "boolean") return false;
	if (!Array.isArray(candidate.diagnostics)) return false;
	if (candidate.errorMessage !== void 0 && typeof candidate.errorMessage !== "string") return false;
	return candidate.diagnostics.every(isDiagnostic);
}
function loadAll() {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isRecord);
	} catch {
		return [];
	}
}
function saveAll(records) {
	if (typeof window === "undefined") return;
	try {
		const trimmed = records.slice(0, MAX);
		window.localStorage.setItem(KEY, JSON.stringify(trimmed));
	} catch {}
}
function recordLaunchAttempt(record) {
	saveAll([record, ...loadAll()].slice(0, MAX));
}
function getLaunchHistoryForApp(appName) {
	return loadAll().filter((record) => record.appName === appName);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/per-app-config.js
/**
* Per-app config — launch mode, always-on-top default, and free-form
* app-declared settings. NOT widget visibility (lives in widgets/visibility.ts).
*
* Persisted to localStorage under `eliza:apps:<slug>`. Subscribers receive
* change notifications via the `storage` event so multiple windows stay in
* sync.
*/
const DEFAULT_CONFIG = {
	launchMode: "window",
	alwaysOnTop: false,
	settings: {}
};
const KEY_PREFIX = "eliza:apps:";
function storageKey(slug) {
	return `${KEY_PREFIX}${slug}`;
}
function isLaunchMode(value) {
	return value === "window" || value === "inline";
}
function sanitizeSettings(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const next = {};
	for (const [key, raw] of Object.entries(value)) if (typeof key === "string" && key.length > 0) next[key] = raw;
	return next;
}
function parseConfig(raw) {
	if (!raw) return {
		...DEFAULT_CONFIG,
		settings: {}
	};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			...DEFAULT_CONFIG,
			settings: {}
		};
	}
	if (!parsed || typeof parsed !== "object") return {
		...DEFAULT_CONFIG,
		settings: {}
	};
	const candidate = parsed;
	return {
		launchMode: isLaunchMode(candidate.launchMode) ? candidate.launchMode : DEFAULT_CONFIG.launchMode,
		alwaysOnTop: typeof candidate.alwaysOnTop === "boolean" ? candidate.alwaysOnTop : DEFAULT_CONFIG.alwaysOnTop,
		settings: sanitizeSettings(candidate.settings)
	};
}
function loadPerAppConfig(slug) {
	if (typeof window === "undefined") return {
		...DEFAULT_CONFIG,
		settings: {}
	};
	try {
		return parseConfig(window.localStorage.getItem(storageKey(slug)));
	} catch {
		return {
			...DEFAULT_CONFIG,
			settings: {}
		};
	}
}
function savePerAppConfig(slug, config) {
	if (typeof window === "undefined") return;
	try {
		const sanitized = {
			launchMode: isLaunchMode(config.launchMode) ? config.launchMode : DEFAULT_CONFIG.launchMode,
			alwaysOnTop: Boolean(config.alwaysOnTop),
			settings: sanitizeSettings(config.settings)
		};
		window.localStorage.setItem(storageKey(slug), JSON.stringify(sanitized));
	} catch {}
}
function subscribePerAppConfig(slug, listener) {
	if (typeof window === "undefined") return () => {};
	const key = storageKey(slug);
	const handler = (event) => {
		if (event.key !== key) return;
		listener(parseConfig(event.newValue));
	};
	window.addEventListener("storage", handler);
	return () => {
		window.removeEventListener("storage", handler);
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/apps/useRegistryCatalog.js
/**
* Shared catalog fetch for views that need to resolve a slug against the
* union of `client.listApps()` (installed) and `client.listCatalogApps()`
* (registry). A module-level promise coalesces concurrent callers so two
* views mounted for the same slug only hit the API once.
*/
let inflight = null;
function fetchRegistryCatalog() {
	if (inflight) return inflight;
	inflight = (async () => {
		const [serverApps, catalogApps] = await Promise.all([client.listApps().catch(() => []), client.listCatalogApps().catch(() => [])]);
		return [...catalogApps, ...serverApps].filter((entry, index, items) => !items.slice(index + 1).some((candidate) => candidate.name === entry.name));
	})().finally(() => {
		inflight = null;
	});
	return inflight;
}
function useRegistryCatalog() {
	const [state, setState] = useState({
		catalog: null,
		error: null
	});
	useEffect(() => {
		let cancelled = false;
		fetchRegistryCatalog().then((catalog) => {
			if (cancelled) return;
			setState({
				catalog,
				error: null
			});
		}, (err) => {
			if (cancelled) return;
			setState({
				catalog: null,
				error: err instanceof Error ? err.message : String(err)
			});
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return state;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/AppDetailsView.js
/**
* AppDetailsView — config + diagnostics + widgets + Launch button page
* for apps that need it (those with `hasDetailsPage: true` in their
* descriptor, or any registry/catalog app with launch params).
*
* Mounted by AppsView when the apps sub-path is `/apps/<slug>/details`.
*/
function pluginIdFromName(name) {
	return name.replace(/^@elizaos\/app-/, "");
}
function resolveAppFromSlug(slug, catalog) {
	const internal = getInternalToolAppDescriptors().find((d) => d.windowPath === `/apps/${slug}`);
	if (internal) {
		const info = getInternalToolApps().find((a) => a.name === internal.name);
		if (info) return {
			source: "internal-tool",
			info,
			pluginId: pluginIdFromName(internal.name),
			windowPath: internal.windowPath ?? `/apps/${slug}`
		};
	}
	const overlay = getAllOverlayApps().find((a) => getAppSlug(a.name) === slug && isOverlayApp(a.name));
	if (overlay) return {
		source: "overlay",
		info: overlayAppToRegistryInfo(overlay),
		pluginId: pluginIdFromName(overlay.name),
		windowPath: `/apps/${slug}`
	};
	const catalogHit = findAppBySlug(catalog, slug);
	if (catalogHit) return {
		source: "catalog",
		info: catalogHit,
		pluginId: pluginIdFromName(catalogHit.name),
		windowPath: `/apps/${slug}`
	};
	return null;
}
function sourceLabel(source) {
	switch (source) {
		case "internal-tool": return "Internal Tool";
		case "overlay": return "Overlay App";
		case "catalog": return "Catalog App";
		default: return "Unknown";
	}
}
function isOverlayLaunchApp$1(app) {
	return isOverlayApp(app.name) || app.launchType === "overlay";
}
function formatTimestamp(value) {
	try {
		return new Date(value).toLocaleString();
	} catch {
		return String(value);
	}
}
function formatLabel(value) {
	return value.replaceAll("-", " ");
}
function SectionHeader({ children }) {
	return (0, import_jsx_runtime.jsx)("h3", {
		className: "text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent",
		children
	});
}
function ChipList({ items }) {
	if (items.length === 0) return (0, import_jsx_runtime.jsx)("span", {
		className: "text-xs text-muted",
		children: "None declared"
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex flex-wrap gap-1.5",
		children: items.map((item) => (0, import_jsx_runtime.jsx)("span", {
			className: "rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-xs text-muted",
			children: item
		}, item))
	});
}
function WidgetPreview({ declaration, pluginId }) {
	const Component = useMemo(() => getWidgetComponent(pluginId, declaration.id), [declaration.id, pluginId]);
	if (!Component) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-md border border-border/40 bg-card/30 px-3 py-2 text-xs text-muted",
		children: "No bundled component for this widget — preview unavailable."
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-md border border-border/40 bg-card/30 p-3",
		children: (0, import_jsx_runtime.jsx)(Component, {
			pluginId,
			events: [],
			clearEvents: () => {}
		})
	});
}
function AppDetailsView({ slug, onLaunched }) {
	const { plugins, appRuns, t, setTab, setState, setActionNotice } = useApp();
	const { catalog: registryCatalog, error: catalogError } = useRegistryCatalog();
	const catalog = registryCatalog ?? [];
	const resolved = useMemo(() => resolveAppFromSlug(slug, catalog), [catalog, slug]);
	const [config, setConfig] = useState(() => loadPerAppConfig(slug));
	useEffect(() => {
		setConfig(loadPerAppConfig(slug));
		return subscribePerAppConfig(slug, setConfig);
	}, [slug]);
	const updateConfig = useCallback((next) => {
		const merged = {
			launchMode: next.launchMode ?? config.launchMode,
			alwaysOnTop: next.alwaysOnTop !== void 0 ? next.alwaysOnTop : config.alwaysOnTop,
			settings: next.settings ?? config.settings
		};
		setConfig(merged);
		savePerAppConfig(slug, merged);
	}, [config, slug]);
	const [visibility, setVisibility] = useState(() => loadChatSidebarVisibility());
	const toggleWidget = useCallback((decl, enabled) => {
		const key = widgetVisibilityKey(decl.pluginId, decl.id);
		const next = { overrides: {
			...visibility.overrides,
			[key]: enabled
		} };
		setVisibility(next);
		saveChatSidebarVisibility(next);
	}, [visibility]);
	const widgets = useMemo(() => {
		if (!resolved) return [];
		return ((plugins?.find((p) => p.id === resolved.pluginId))?.widgets ?? []).map((decl) => ({
			...decl,
			slot: decl.slot
		}));
	}, [plugins, resolved]);
	const [expandedWidget, setExpandedWidget] = useState(null);
	const [history, setHistory] = useState([]);
	useEffect(() => {
		if (resolved) setHistory(getLaunchHistoryForApp(resolved.info.name));
	}, [resolved]);
	const recentRuns = useMemo(() => {
		if (!resolved || !appRuns) return [];
		return appRuns.filter((r) => r.appName === resolved.info.name).slice(0, 5);
	}, [appRuns, resolved]);
	const [launching, setLaunching] = useState(false);
	const handleLaunch = useCallback(async () => {
		if (!resolved || launching) return;
		setLaunching(true);
		const recordResult = (succeeded, errorMessage) => {
			recordLaunchAttempt({
				appName: resolved.info.name,
				timestamp: Date.now(),
				succeeded,
				diagnostics: [],
				...errorMessage ? { errorMessage } : {}
			});
			setHistory(getLaunchHistoryForApp(resolved.info.name));
		};
		try {
			if (config.launchMode === "inline") {
				if (resolved.source === "internal-tool") {
					const tab = getInternalToolAppTargetTab(resolved.info.name);
					if (tab) {
						setTab(tab);
						recordResult(true);
						onLaunched?.({
							mode: "inline",
							slug
						});
						return;
					}
				}
				if (resolved.source === "overlay" || isOverlayLaunchApp$1(resolved.info)) {
					setState("activeOverlayApp", resolved.info.name);
					recordResult(true);
					onLaunched?.({
						mode: "inline",
						slug
					});
					return;
				}
			}
			if (!isElectrobunRuntime()) {
				const tab = getInternalToolAppTargetTab(resolved.info.name);
				if (tab) {
					setTab(tab);
					recordResult(true);
					onLaunched?.({
						mode: "inline",
						slug
					});
					return;
				}
				if (isOverlayLaunchApp$1(resolved.info)) {
					setState("activeOverlayApp", resolved.info.name);
					recordResult(true);
					onLaunched?.({
						mode: "inline",
						slug
					});
					return;
				}
				const result = await client.launchApp(resolved.info.name);
				const primaryDiagnostic = result.diagnostics?.find((diagnostic) => diagnostic.severity === "error") ?? result.diagnostics?.[0];
				const launchedRun = result.run;
				if (launchedRun?.viewer?.url) {
					setState("appRuns", [launchedRun, ...appRuns.filter((run) => run.runId !== launchedRun.runId)]);
					setState("activeGameRunId", launchedRun.runId);
					setState("tab", "apps");
					setState("appsSubTab", "games");
					recordResult(true);
					onLaunched?.({
						mode: "window",
						slug
					});
					return;
				}
				const targetUrl = result.launchUrl ?? resolved.info.launchUrl;
				if (targetUrl) {
					await openExternalUrl(targetUrl);
					recordResult(true);
					onLaunched?.({
						mode: "window",
						slug
					});
					return;
				}
				throw new Error(primaryDiagnostic?.message ?? t("appdetails.LaunchedNoViewer", { defaultValue: "This app launched without a viewer URL." }));
			}
			if (!(await invokeDesktopBridgeRequest({
				rpcMethod: "desktopOpenAppWindow",
				ipcChannel: "desktop:openAppWindow",
				params: {
					slug,
					title: resolved.info.displayName ?? resolved.info.name,
					path: resolved.windowPath,
					alwaysOnTop: config.alwaysOnTop
				}
			}))?.id) throw new Error("Desktop bridge declined to open the window.");
			recordResult(true);
			onLaunched?.({
				mode: "window",
				slug
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordResult(false, message);
			setActionNotice(t("appdetails.LaunchFailed", { defaultValue: `Could not launch ${resolved.info.displayName}: ${message}` }), "error", 4e3);
		} finally {
			setLaunching(false);
		}
	}, [
		appRuns,
		config.alwaysOnTop,
		config.launchMode,
		launching,
		onLaunched,
		resolved,
		setActionNotice,
		setState,
		setTab,
		slug,
		t
	]);
	if (catalogError && !resolved) return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted",
		children: [(0, import_jsx_runtime.jsx)(TriangleAlert, { className: "h-5 w-5 text-accent" }), (0, import_jsx_runtime.jsx)("span", { children: catalogError })]
	});
	if (!resolved) return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full min-h-0 w-full items-center justify-center text-sm text-muted",
		children: [
			"Loading ",
			slug,
			"…"
		]
	});
	const supportsInlineMode = resolved.source === "internal-tool" || resolved.source === "overlay";
	const DetailExtension = getAppDetailExtension(resolved.info);
	const activeRun = recentRuns[0] ?? null;
	const latestFailure = history.find((entry) => !entry.succeeded);
	const viewerUrl = resolved.info.viewer?.url ?? resolved.info.launchUrl;
	const launchTarget = viewerUrl ?? resolved.windowPath;
	const sessionMode = resolved.info.session?.mode;
	const sessionFeatures = resolved.info.session?.features ?? [];
	const launchModeLabel = config.launchMode === "inline" && supportsInlineMode ? "Main window" : "Dedicated window";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "device-layout mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 lg:px-6",
		children: [
			(0, import_jsx_runtime.jsx)("header", {
				className: "flex flex-col gap-3 border-b border-border/35 pb-5",
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-4",
					children: [resolved.info.heroImage ? (0, import_jsx_runtime.jsx)("img", {
						src: resolveRuntimeImageUrl(resolved.info.heroImage),
						alt: "",
						className: "h-14 w-14 rounded-lg border border-border/40 object-cover"
					}) : (0, import_jsx_runtime.jsx)("div", {
						className: "flex h-14 w-14 items-center justify-center rounded-lg border border-border/40 bg-card/40 text-xs uppercase text-muted",
						children: (resolved.info.displayName ?? resolved.info.name).slice(0, 2).toUpperCase()
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0",
						children: [
							(0, import_jsx_runtime.jsx)("h2", {
								className: "truncate text-base font-semibold text-foreground",
								children: resolved.info.displayName ?? resolved.info.name
							}),
							(0, import_jsx_runtime.jsx)("p", {
								className: "truncate text-xs text-muted",
								children: resolved.info.name
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted",
								children: [(0, import_jsx_runtime.jsx)("span", { children: sourceLabel(resolved.source) }), recentRuns.length > 0 ? (0, import_jsx_runtime.jsxs)("span", {
									className: "rounded-full bg-accent/15 px-2 py-0.5 text-accent",
									children: [recentRuns.length, " running"]
								}) : null]
							})
						]
					})]
				})
			}),
			(0, import_jsx_runtime.jsxs)("section", {
				"data-testid": "app-launch-panel",
				className: "flex flex-col gap-4 rounded-lg border border-border/45 bg-card/30 p-4",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-col gap-1",
							children: [(0, import_jsx_runtime.jsx)(SectionHeader, { children: "Launch" }), (0, import_jsx_runtime.jsx)("p", {
								className: "text-xs text-muted",
								children: activeRun ? `${activeRun.displayName} is ${activeRun.status}.` : "Ready to launch."
							})]
						}), (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: handleLaunch,
							disabled: launching,
							className: "inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60",
							children: [(0, import_jsx_runtime.jsx)(Rocket, {
								className: "h-3.5 w-3.5",
								"aria-hidden": "true"
							}), launching ? "Launching..." : `Launch ${resolved.info.displayName ?? "App"}`]
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-4",
						children: [
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 border-l border-border/35 pl-3",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-[10px] uppercase tracking-[0.14em] text-muted",
									children: "Run"
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "truncate text-sm font-medium text-foreground",
									children: activeRun?.status ?? "Ready"
								})]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 border-l border-border/35 pl-3",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-[10px] uppercase tracking-[0.14em] text-muted",
									children: "Window"
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "truncate text-sm font-medium text-foreground",
									children: launchModeLabel
								})]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 border-l border-border/35 pl-3",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-[10px] uppercase tracking-[0.14em] text-muted",
									children: "Target"
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "truncate text-sm font-medium text-foreground",
									title: launchTarget,
									children: viewerUrl ? "Viewer" : "App route"
								})]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 border-l border-border/35 pl-3",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-[10px] uppercase tracking-[0.14em] text-muted",
									children: "Session"
								}), (0, import_jsx_runtime.jsx)("div", {
									className: "truncate text-sm font-medium text-foreground",
									children: sessionMode ? formatLabel(sessionMode) : "Not declared"
								})]
							})
						]
					}),
					sessionFeatures.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
						className: "flex flex-wrap gap-1.5",
						children: sessionFeatures.map((feature) => (0, import_jsx_runtime.jsx)("span", {
							className: "rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-xs text-muted",
							children: formatLabel(feature)
						}, feature))
					}) : null,
					latestFailure ? (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-muted",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "font-medium text-destructive",
							children: "Last failure: "
						}), latestFailure.errorMessage ?? "Launch failed."]
					}) : null,
					(0, import_jsx_runtime.jsxs)("fieldset", {
						className: "flex flex-col gap-2 rounded-md border border-border/40 bg-bg/20 p-3",
						children: [
							(0, import_jsx_runtime.jsxs)("legend", {
								className: "px-1 text-xs uppercase tracking-[0.14em] text-muted",
								children: [(0, import_jsx_runtime.jsx)(Settings, { className: "mr-1 inline h-3 w-3" }), " Launch Destination"]
							}),
							(0, import_jsx_runtime.jsxs)("label", {
								className: "flex cursor-pointer items-center gap-2 text-sm",
								children: [(0, import_jsx_runtime.jsx)("input", {
									type: "radio",
									checked: config.launchMode === "window",
									onChange: () => updateConfig({ launchMode: "window" }),
									className: "h-3.5 w-3.5 accent-accent"
								}), (0, import_jsx_runtime.jsx)("span", { children: "Dedicated window" })]
							}),
							(0, import_jsx_runtime.jsxs)("label", {
								className: `flex items-center gap-2 text-sm ${supportsInlineMode ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`,
								children: [(0, import_jsx_runtime.jsx)("input", {
									type: "radio",
									checked: config.launchMode === "inline",
									disabled: !supportsInlineMode,
									onChange: () => updateConfig({ launchMode: "inline" }),
									className: "h-3.5 w-3.5 accent-accent"
								}), (0, import_jsx_runtime.jsxs)("span", { children: ["Main window", !supportsInlineMode ? " (not supported)" : ""] })]
							})
						]
					}),
					(0, import_jsx_runtime.jsxs)("label", {
						className: `inline-flex items-center gap-2 self-start rounded-full border border-border/60 bg-bg/20 px-3 py-1.5 text-xs ${config.launchMode === "window" ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`,
						children: [
							(0, import_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: config.alwaysOnTop,
								disabled: config.launchMode !== "window",
								onChange: (event) => updateConfig({ alwaysOnTop: event.currentTarget.checked }),
								className: "h-3.5 w-3.5 accent-accent"
							}),
							config.alwaysOnTop ? (0, import_jsx_runtime.jsx)(Pin, {
								className: "h-3.5 w-3.5",
								"aria-hidden": "true"
							}) : (0, import_jsx_runtime.jsx)(PinOff, {
								className: "h-3.5 w-3.5",
								"aria-hidden": "true"
							}),
							(0, import_jsx_runtime.jsx)("span", { children: "Keep this app's window on top" })
						]
					})
				]
			}),
			(0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-3",
				children: [
					(0, import_jsx_runtime.jsx)(SectionHeader, { children: "About" }),
					resolved.info.description ? (0, import_jsx_runtime.jsx)("p", {
						className: "text-sm text-muted",
						children: resolved.info.description
					}) : null,
					(0, import_jsx_runtime.jsx)(ChipList, { items: resolved.info.capabilities ?? [] })
				]
			}),
			DetailExtension ? (0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-3",
				children: [(0, import_jsx_runtime.jsx)(SectionHeader, { children: "Details" }), (0, import_jsx_runtime.jsx)(DetailExtension, { app: resolved.info })]
			}) : null,
			recentRuns.length > 0 ? (0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-2",
				children: [(0, import_jsx_runtime.jsx)(SectionHeader, { children: "Recent Runs" }), (0, import_jsx_runtime.jsx)("ul", {
					className: "flex flex-col gap-1 text-xs text-muted",
					children: recentRuns.map((run) => (0, import_jsx_runtime.jsxs)("li", {
						className: "flex items-center justify-between rounded-md border border-border/40 bg-card/30 px-3 py-1.5",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "truncate",
							children: run.runId
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "ml-2 shrink-0 uppercase tracking-[0.14em]",
							children: run.status
						})]
					}, run.runId))
				})]
			}) : null,
			(0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-2",
				children: [(0, import_jsx_runtime.jsx)(SectionHeader, { children: "Launch Diagnostics" }), history.length === 0 ? (0, import_jsx_runtime.jsx)("p", {
					className: "text-xs text-muted",
					children: "No launch history yet."
				}) : (0, import_jsx_runtime.jsx)("ul", {
					className: "flex flex-col gap-1 text-xs",
					children: history.slice(0, 5).map((entry) => (0, import_jsx_runtime.jsxs)("li", {
						className: "rounded-md border border-border/40 bg-card/30 px-3 py-1.5",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center justify-between",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "text-muted",
								children: formatTimestamp(entry.timestamp)
							}), (0, import_jsx_runtime.jsx)("span", {
								className: entry.succeeded ? "text-accent" : "text-destructive",
								children: entry.succeeded ? "OK" : "FAILED"
							})]
						}), entry.errorMessage ? (0, import_jsx_runtime.jsx)("p", {
							className: "mt-1 text-muted",
							children: entry.errorMessage
						}) : null]
					}, entry.timestamp))
				})]
			}),
			widgets.length > 0 ? (0, import_jsx_runtime.jsxs)("section", {
				className: "flex flex-col gap-2",
				children: [(0, import_jsx_runtime.jsx)(SectionHeader, { children: "Widgets" }), (0, import_jsx_runtime.jsx)("ul", {
					className: "flex flex-col gap-2",
					children: widgets.map((decl) => {
						const visible = isWidgetVisible(decl, visibility.overrides);
						const widgetKey = widgetVisibilityKey(decl.pluginId, decl.id);
						const expanded = expandedWidget === widgetKey;
						return (0, import_jsx_runtime.jsxs)("li", {
							className: "rounded-md border border-border/40 bg-card/30",
							children: [(0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center justify-between gap-3 px-3 py-2",
								children: [(0, import_jsx_runtime.jsxs)("div", {
									className: "min-w-0",
									children: [(0, import_jsx_runtime.jsx)("div", {
										className: "truncate text-sm font-medium text-foreground",
										children: decl.label
									}), (0, import_jsx_runtime.jsx)("div", {
										className: "truncate text-[10px] uppercase tracking-[0.14em] text-muted",
										children: decl.slot
									})]
								}), (0, import_jsx_runtime.jsxs)("div", {
									className: "flex shrink-0 items-center gap-2",
									children: [(0, import_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setExpandedWidget(expanded ? null : widgetKey),
										className: "rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-foreground",
										children: expanded ? "Hide" : "Preview"
									}), (0, import_jsx_runtime.jsxs)("label", {
										className: "inline-flex cursor-pointer items-center gap-1.5 text-xs",
										children: [(0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: visible,
											onChange: (event) => toggleWidget(decl, event.currentTarget.checked),
											className: "h-3.5 w-3.5 accent-accent"
										}), (0, import_jsx_runtime.jsx)("span", {
											className: "text-muted",
											children: "Show"
										})]
									})]
								})]
							}), expanded ? (0, import_jsx_runtime.jsx)("div", {
								className: "border-t border-border/40 p-3",
								children: (0, import_jsx_runtime.jsx)(WidgetPreview, {
									declaration: decl,
									pluginId: resolved.pluginId
								})
							}) : null]
						}, widgetKey);
					})
				})]
			}) : null
		]
	});
}
/**
* Convenience: does this slug resolve to an app that wants the details
* page? Used by AppsView.handleLaunch to decide whether to navigate to
* /apps/<slug>/details or call openAppRouteWindow directly.
*
* Internal tools opt in with `hasDetailsPage`; catalog apps opt in through
* launch metadata that implies setup, runtime control, or a heavier session.
*/
function appNeedsDetailsPage(app) {
	const name = typeof app === "string" ? app : app.name;
	if (isInternalToolApp(name)) return getInternalToolAppHasDetailsPage(name);
	if (isOverlayApp(name)) return false;
	if (typeof app !== "string" && app.launchType === "overlay") return false;
	if (typeof app === "string") return false;
	if (app.uiExtension?.detailPanelId) return true;
	if (app.session) return true;
	if (app.category.trim().toLowerCase() === "game") return true;
	return false;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/AppsView.js
/** Max items retained in launch history. */
const RECENT_APPS_LIMIT = 10;
const APPS_SIDEBAR_WIDTH_KEY = "eliza:apps:sidebar:width";
const APPS_SIDEBAR_COLLAPSED_KEY = "eliza:apps:sidebar:collapsed";
const APPS_SIDEBAR_DEFAULT_WIDTH = 240;
const APPS_SIDEBAR_MIN_WIDTH = 200;
const APPS_SIDEBAR_MAX_WIDTH = 520;
const APP_WINDOW_ALWAYS_ON_TOP_KEY = "eliza:apps:window:always-on-top";
const APP_WINDOW_HEARTBEAT_MS = 15e3;
function clampWidth(value) {
	return Math.min(Math.max(value, APPS_SIDEBAR_MIN_WIDTH), APPS_SIDEBAR_MAX_WIDTH);
}
function loadInitialSidebarWidth() {
	if (typeof window === "undefined") return APPS_SIDEBAR_DEFAULT_WIDTH;
	try {
		const raw = window.localStorage.getItem(APPS_SIDEBAR_WIDTH_KEY);
		const parsed = raw ? Number.parseInt(raw, 10) : NaN;
		if (Number.isFinite(parsed)) return clampWidth(parsed);
	} catch {}
	return APPS_SIDEBAR_DEFAULT_WIDTH;
}
function loadInitialSidebarCollapsed() {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(APPS_SIDEBAR_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}
function loadInitialAppWindowAlwaysOnTop() {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(APP_WINDOW_ALWAYS_ON_TOP_KEY) === "true";
	} catch {
		return false;
	}
}
function getCurrentAppsPath() {
	return getWindowNavigationPath();
}
/**
* Parse the current apps sub-path into `{slug, action}`. Action recognizes
* `details` for `/apps/<slug>/details`. Anything else is treated as a
* direct app surface (`action: null`).
*/
function parseAppsRoute(path) {
	if (!path.startsWith("/apps/")) return {
		slug: null,
		action: null
	};
	const after = path.slice(6).replace(/[?#].*$/, "");
	if (!after) return {
		slug: null,
		action: null
	};
	const [slug, sub] = after.split("/");
	return {
		slug: slug || null,
		action: sub === "details" ? "details" : null
	};
}
function resolveDesktopViewerUrl(viewerUrl) {
	const resolved = resolveEmbeddedViewerUrl(viewerUrl);
	if (!resolved) return null;
	try {
		const parsed = new URL(resolved);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.toString();
	} catch {
		return null;
	}
}
function getApiStatus(err) {
	if (err && typeof err === "object" && "status" in err && typeof err.status === "number") return err.status;
	return null;
}
function isClosedCanvasWindowEvent(payload) {
	if (payload === null || typeof payload !== "object") return false;
	const candidate = payload;
	return "windowId" in payload && typeof candidate.windowId === "string" && "event" in payload && candidate.event === "closed";
}
function isManagedWindowsChangedEvent(payload) {
	if (payload === null || typeof payload !== "object") return false;
	const windows = payload.windows;
	return Array.isArray(windows);
}
function isOverlayLaunchApp(app) {
	return isOverlayApp(app.name) || app.launchType === "overlay";
}
function AppsView() {
	const { appRuns, activeGameRunId, activeGameViewerUrl, appsSubTab, favoriteApps, walletEnabled, recentApps, setTab, setState, setActionNotice, t } = useApp();
	const [apps, setApps] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [searchQuery, _setSearchQuery] = useState("");
	const [busyRunId, setBusyRunId] = useState(null);
	const [stoppingRunId, setStoppingRunId] = useState(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(loadInitialSidebarCollapsed);
	const [sidebarWidth, setSidebarWidth] = useState(loadInitialSidebarWidth);
	const [appWindowAlwaysOnTop] = useState(loadInitialAppWindowAlwaysOnTop);
	const [isAppWindow] = useState(isAppWindowRoute);
	const [appWindows, setAppWindows] = useState([]);
	const [busyAppWindowId, setBusyAppWindowId] = useState(null);
	const slugAutoLaunchDone = useRef(false);
	const appWindowsRef = useRef([]);
	const handleSidebarCollapsedChange = useCallback((next) => {
		setSidebarCollapsed(next);
		try {
			window.localStorage.setItem(APPS_SIDEBAR_COLLAPSED_KEY, String(next));
		} catch {}
	}, []);
	const handleSidebarWidthChange = useCallback((next) => {
		const clamped = clampWidth(next);
		setSidebarWidth(clamped);
		try {
			window.localStorage.setItem(APPS_SIDEBAR_WIDTH_KEY, String(clamped));
		} catch {}
	}, []);
	useEffect(() => {
		appWindowsRef.current = appWindows;
	}, [appWindows]);
	useEffect(() => {
		return subscribeDesktopBridgeEvent({
			rpcMessage: "canvasWindowEvent",
			ipcChannel: "canvas:windowEvent",
			listener: (payload) => {
				if (!isClosedCanvasWindowEvent(payload)) return;
				setAppWindows((current) => current.filter((item) => item.id !== payload.windowId));
			}
		});
	}, []);
	useEffect(() => {
		return subscribeDesktopBridgeEvent({
			rpcMessage: "desktopManagedWindowsChanged",
			ipcChannel: "desktop:managedWindowsChanged",
			listener: (payload) => {
				if (!isManagedWindowsChangedEvent(payload)) return;
				setAppWindows((current) => {
					const currentById = new Map(current.map((record) => [record.id, record]));
					return [...payload.windows.filter((windowRecord) => windowRecord.surface !== "settings").map((windowRecord) => {
						const existing = currentById.get(windowRecord.id);
						return {
							id: windowRecord.id,
							kind: "managed",
							runId: "",
							appName: existing?.appName ?? "",
							displayName: existing?.displayName ?? windowRecord.title,
							alwaysOnTop: windowRecord.alwaysOnTop
						};
					}), ...current.filter((record) => record.kind === "game")];
				});
			}
		});
	}, []);
	const activeAppNames = useMemo(() => new Set(appRuns.map((run) => run.appName)), [appRuns]);
	const favoriteAppNames = useMemo(() => new Set(favoriteApps), [favoriteApps]);
	const activeGameRun = useMemo(() => appRuns.find((run) => run.runId === activeGameRunId) ?? null, [activeGameRunId, appRuns]);
	const currentGameViewerUrl = typeof activeGameViewerUrl === "string" ? activeGameViewerUrl.trim() : "";
	const hasActiveRun = Boolean(activeGameRun);
	const hasCurrentGame = currentGameViewerUrl.length > 0 && activeGameRun?.viewerAttachment === "attached";
	/**
	* Push or replace the browser URL to reflect the active app (or browse).
	* `subPath` is appended after the slug so `/apps/<slug>/details` shows
	* the details page instead of launching directly.
	*/
	const pushAppsUrl = useCallback((slug, subPath) => {
		try {
			const path = slug ? subPath ? `/apps/${slug}/${subPath}` : `/apps/${slug}` : "/apps";
			if (shouldUseHashNavigation()) window.location.hash = path;
			else window.history.replaceState(null, "", path);
		} catch {}
	}, []);
	const [appsDetailsSlug, setAppsDetailsSlug] = useState(() => parseAppsRoute(getCurrentAppsPath()).action === "details" ? parseAppsRoute(getCurrentAppsPath()).slug : null);
	useEffect(() => {
		const handle = () => {
			const parsed = parseAppsRoute(getCurrentAppsPath());
			setAppsDetailsSlug(parsed.action === "details" ? parsed.slug : null);
		};
		window.addEventListener("hashchange", handle);
		window.addEventListener("popstate", handle);
		return () => {
			window.removeEventListener("hashchange", handle);
			window.removeEventListener("popstate", handle);
		};
	}, []);
	useEffect(() => {
		return subscribeDesktopBridgeEvent({
			rpcMessage: "desktopAppDetailsRequested",
			ipcChannel: "desktop:appDetailsRequested",
			listener: (payload) => {
				if (!payload || typeof payload !== "object" || typeof payload.slug !== "string") return;
				const slug = payload.slug;
				if (!slug) return;
				setTab("apps");
				setState("appsSubTab", "browse");
				setAppsDetailsSlug(slug);
				pushAppsUrl(slug, "details");
			}
		});
	}, [
		pushAppsUrl,
		setState,
		setTab
	]);
	const sortedRuns = useMemo(() => [...appRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [appRuns]);
	const mergeRun = useCallback((run) => {
		const nextRuns = [run, ...appRuns.filter((item) => item.runId !== run.runId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		setState("appRuns", nextRuns);
		return nextRuns;
	}, [appRuns, setState]);
	const refreshRuns = useCallback(async () => {
		const runs = await client.listAppRuns();
		setState("appRuns", runs);
		return runs;
	}, [setState]);
	useEffect(() => {
		if (appWindows.length === 0) return;
		let cancelled = false;
		const heartbeat = async () => {
			const records = appWindowsRef.current;
			for (const record of records) {
				if (!record.runId) continue;
				try {
					await client.heartbeatAppRun(record.runId);
				} catch (err) {
					if (cancelled || getApiStatus(err) !== 404) continue;
					setAppWindows((current) => current.filter((item) => item.runId !== record.runId));
					refreshRuns().catch(() => {});
				}
			}
		};
		heartbeat();
		const timer = window.setInterval(() => {
			heartbeat();
		}, APP_WINDOW_HEARTBEAT_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [appWindows.length, refreshRuns]);
	const loadApps = useCallback(async () => {
		setLoading(true);
		setError(null);
		refreshRuns().catch((err) => {
			console.warn("[AppsView] Failed to list app runs:", err);
		});
		try {
			const serverAppsResult = await client.listApps().then((apps) => ({
				status: "fulfilled",
				value: apps
			})).catch((reason) => ({
				status: "rejected",
				reason
			}));
			const serverApps = serverAppsResult.status === "fulfilled" ? serverAppsResult.value : [];
			if (serverAppsResult.status === "rejected") console.warn("[AppsView] Failed to list apps:", serverAppsResult.reason);
			let catalogApps;
			try {
				catalogApps = [...getInternalToolApps(), ...await client.listCatalogApps()];
			} catch (catalogErr) {
				console.warn("[AppsView] Failed to load catalog apps; using internal tools:", catalogErr);
				catalogApps = getInternalToolApps();
			}
			const overlayDescriptors = getAllOverlayApps().filter((oa) => !serverApps.some((a) => a.name === oa.name)).filter((oa) => !catalogApps.some((a) => a.name === oa.name)).map(overlayAppToRegistryInfo);
			const seen = /* @__PURE__ */ new Set();
			setApps([
				...catalogApps,
				...overlayDescriptors,
				...serverApps
			].filter((app) => {
				if (seen.has(app.name)) return false;
				seen.add(app.name);
				return true;
			}));
		} catch (err) {
			setError(t("appsview.LoadError", { message: err instanceof Error ? err.message : t("appsview.NetworkError") }));
		} finally {
			setLoading(false);
		}
	}, [refreshRuns, t]);
	useEffect(() => {
		loadApps();
	}, [loadApps]);
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				await refreshRuns();
			} catch (err) {
				if (!cancelled) console.warn("[AppsView] Failed to refresh app runs:", err);
			}
		};
		const timer = setInterval(() => {
			refresh();
		}, 5e3);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [refreshRuns]);
	useEffect(() => {
		if (appsSubTab !== "running") return;
		setState("appsSubTab", "browse");
	}, [appsSubTab, setState]);
	const pushRecentApp = useCallback((appName) => {
		const next = [appName, ...recentApps.filter((name) => name !== appName)];
		if (next.length > RECENT_APPS_LIMIT) next.length = RECENT_APPS_LIMIT;
		setState("recentApps", next);
	}, [recentApps, setState]);
	const openAppRouteWindow = useCallback(async (app) => {
		if (isAppWindow || !isElectrobunRuntime()) return false;
		const internalWindowPath = getInternalToolAppWindowPath(app.name);
		if (internalWindowPath) {
			const slug = getAppSlug(app.name);
			const created = await invokeDesktopBridgeRequest({
				rpcMethod: "desktopOpenAppWindow",
				ipcChannel: "desktop:openAppWindow",
				params: {
					slug,
					title: app.displayName ?? app.name,
					path: internalWindowPath,
					alwaysOnTop: appWindowAlwaysOnTop
				}
			});
			if (!created?.id) return false;
			setAppWindows((current) => [{
				id: created.id,
				kind: "managed",
				runId: "",
				appName: app.name,
				displayName: app.displayName ?? app.name,
				alwaysOnTop: created.alwaysOnTop
			}, ...current.filter((item) => item.id !== created.id)]);
			pushRecentApp(app.name);
			setState("appsSubTab", "browse");
			pushAppsUrl(slug);
			setActionNotice(t("appsview.OpenedInDesktopWindow", {
				defaultValue: `${app.displayName ?? app.name} opened in a desktop window.`,
				name: app.displayName ?? app.name
			}), "success", 2600);
			return true;
		}
		const slug = getAppSlug(app.name);
		const created = await invokeDesktopBridgeRequest({
			rpcMethod: "desktopOpenAppWindow",
			ipcChannel: "desktop:openAppWindow",
			params: {
				slug,
				title: app.displayName ?? app.name,
				path: `/apps/${encodeURIComponent(slug)}`,
				alwaysOnTop: appWindowAlwaysOnTop
			}
		});
		if (!created?.id) return false;
		setAppWindows((current) => [{
			id: created.id,
			kind: "managed",
			runId: "",
			appName: app.name,
			displayName: app.displayName ?? app.name,
			alwaysOnTop: created.alwaysOnTop
		}, ...current.filter((item) => item.id !== created.id)]);
		pushRecentApp(app.name);
		setState("appsSubTab", "browse");
		pushAppsUrl(getAppSlug(app.name));
		setActionNotice(t("appsview.OpenedInDesktopWindow", {
			defaultValue: `${app.displayName ?? app.name} opened in a desktop window.`,
			name: app.displayName ?? app.name
		}), "success", 2600);
		return true;
	}, [
		appWindowAlwaysOnTop,
		isAppWindow,
		pushAppsUrl,
		pushRecentApp,
		setActionNotice,
		setState,
		t
	]);
	const openRunInDesktopWindow = useCallback(async (run) => {
		if (!run.viewer?.url || shouldUseEmbeddedAppViewer(run) || !isElectrobunRuntime()) return false;
		const viewerUrl = resolveDesktopViewerUrl(run.viewer.url);
		if (!viewerUrl) return false;
		let runForWindow = run;
		if (run.viewerAttachment !== "attached") {
			runForWindow = (await client.attachAppRun(run.runId)).run ?? {
				...run,
				viewerAttachment: "attached"
			};
			mergeRun(runForWindow);
		}
		const created = await invokeDesktopBridgeRequest({
			rpcMethod: "gameOpenWindow",
			ipcChannel: "game:openWindow",
			params: {
				url: viewerUrl,
				title: runForWindow.displayName,
				alwaysOnTop: appWindowAlwaysOnTop
			}
		});
		if (!created?.id) return false;
		setAppWindows((current) => [{
			id: created.id,
			kind: "game",
			runId: runForWindow.runId,
			appName: runForWindow.appName,
			displayName: runForWindow.displayName,
			alwaysOnTop: appWindowAlwaysOnTop
		}, ...current.filter((item) => item.id !== created.id)]);
		setState("activeGameRunId", runForWindow.runId);
		setState("tab", "apps");
		setState("appsSubTab", "browse");
		pushAppsUrl(getAppSlug(runForWindow.appName));
		client.heartbeatAppRun(runForWindow.runId).catch(() => {});
		setActionNotice(t("appsview.OpenedInDesktopWindow", {
			defaultValue: `${runForWindow.displayName} opened in a desktop window.`,
			name: runForWindow.displayName
		}), "success", 2600);
		return true;
	}, [
		appWindowAlwaysOnTop,
		mergeRun,
		pushAppsUrl,
		setActionNotice,
		setState,
		t
	]);
	const handleLaunch = useCallback(async (app) => {
		slugAutoLaunchDone.current = true;
		if (!isAppWindow && appNeedsDetailsPage(app)) {
			const slug = getAppSlug(app.name);
			pushRecentApp(app.name);
			setState("appsSubTab", "browse");
			setAppsDetailsSlug(slug);
			pushAppsUrl(slug, "details");
			return;
		}
		if (isElectrobunRuntime()) {
			if (await openAppRouteWindow(app).catch(() => false)) return;
		}
		const internalToolTab = getInternalToolAppTargetTab(app.name);
		if (internalToolTab) {
			pushRecentApp(app.name);
			setTab(internalToolTab);
			return;
		}
		if (isOverlayLaunchApp(app)) {
			pushRecentApp(app.name);
			setState("activeOverlayApp", app.name);
			pushAppsUrl(getAppSlug(app.name));
			return;
		}
		try {
			const result = await client.launchApp(app.name);
			const primaryLaunchDiagnostic = result.diagnostics?.find((diagnostic) => diagnostic.severity === "error") ?? result.diagnostics?.[0];
			const primaryRun = (result.run ? mergeRun(result.run) : null)?.find((run) => run.appName === app.name) ?? result.run;
			if (primaryRun) pushRecentApp(app.name);
			if (primaryRun?.viewer?.url) {
				if (await openRunInDesktopWindow(primaryRun).catch(() => false)) {
					if (primaryLaunchDiagnostic?.severity === "error") setActionNotice(primaryLaunchDiagnostic.message, "error", 6500);
					return;
				}
				setState("activeGameRunId", primaryRun.runId);
				if (primaryRun.viewer.postMessageAuth && !primaryRun.viewer.authMessage) setActionNotice(t("appsview.IframeAuthMissing", { name: app.displayName ?? app.name }), "error", 4800);
				if (primaryLaunchDiagnostic) setActionNotice(primaryLaunchDiagnostic.message, primaryLaunchDiagnostic.severity === "error" ? "error" : "info", 6500);
				setState("tab", "apps");
				setState("appsSubTab", "games");
				pushAppsUrl(getAppSlug(app.name));
				return;
			}
			if (primaryRun) {
				setState("appsSubTab", "browse");
				pushAppsUrl(getAppSlug(app.name));
			}
			if (primaryLaunchDiagnostic) setActionNotice(primaryLaunchDiagnostic.message, primaryLaunchDiagnostic.severity === "error" ? "error" : "info", 6500);
			const targetUrl = result.launchUrl ?? app.launchUrl;
			if (targetUrl) {
				try {
					await openExternalUrl(targetUrl);
					setActionNotice(t("appsview.OpenedInNewTab", { name: app.displayName ?? app.name }), "success", 2600);
				} catch {
					setActionNotice(t("appsview.PopupBlockedOpen", { name: app.displayName ?? app.name }), "error", 4200);
				}
				return;
			}
			setActionNotice(t("appsview.LaunchedNoViewer", { name: app.displayName ?? app.name }), "error", 4e3);
		} catch (err) {
			setActionNotice(t("appsview.LaunchFailed", {
				name: app.displayName ?? app.name,
				message: err instanceof Error ? err.message : t("common.error")
			}), "error", 4e3);
		}
	}, [
		mergeRun,
		openAppRouteWindow,
		openRunInDesktopWindow,
		pushAppsUrl,
		pushRecentApp,
		isAppWindow,
		setActionNotice,
		setState,
		setTab,
		t
	]);
	useEffect(() => {
		if (slugAutoLaunchDone.current || apps.length === 0) return;
		const parsed = parseAppsRoute(getCurrentAppsPath());
		if (parsed.action === "details") return;
		const slug = parsed.slug ?? getAppSlugFromPath(getCurrentAppsPath());
		slugAutoLaunchDone.current = true;
		if (!slug) return;
		const app = findAppBySlug(apps, slug);
		if (!app) return;
		if (activeGameRunId && !isOverlayLaunchApp(app)) return;
		handleLaunch(app);
	}, [
		apps,
		handleLaunch,
		activeGameRunId
	]);
	const handleOpenCurrentGame = useCallback(() => {
		if (!hasActiveRun || !activeGameRun) return;
		setState("tab", "apps");
		setState("appsSubTab", "games");
		pushAppsUrl(getAppSlug(activeGameRun.appName));
	}, [
		activeGameRun,
		hasActiveRun,
		pushAppsUrl,
		setState
	]);
	const handleOpenRun = useCallback(async (run) => {
		if (!run.viewer?.url) {
			if (run.launchUrl) {
				try {
					await openExternalUrl(run.launchUrl);
					setActionNotice(t("appsview.OpenedInNewTab", { name: run.displayName }), "success", 2600);
				} catch {
					setActionNotice(t("appsview.PopupBlockedOpen", { name: run.displayName }), "error", 4200);
				}
				return;
			}
			setActionNotice(t("appsview.LaunchedNoViewer", { name: run.displayName }), "info", 3200);
			return;
		}
		setBusyRunId(run.runId);
		try {
			if (await openRunInDesktopWindow(run).catch(() => false)) {
				pushRecentApp(run.appName);
				return;
			}
			const result = run.viewerAttachment === "attached" ? {
				success: true,
				message: `${run.displayName} attached.`,
				run
			} : await client.attachAppRun(run.runId);
			const nextRun = result.run ?? {
				...run,
				viewerAttachment: "attached"
			};
			mergeRun(nextRun);
			pushRecentApp(nextRun.appName);
			setState("activeGameRunId", nextRun.runId);
			setState("tab", "apps");
			setState("appsSubTab", "games");
			pushAppsUrl(getAppSlug(nextRun.appName));
			if (nextRun.viewer?.postMessageAuth && !nextRun.viewer.authMessage) setActionNotice(t("appsview.IframeAuthMissing", { name: nextRun.displayName }), "error", 4800);
			else if (result.message) setActionNotice(result.message, "success", 2200);
		} catch (err) {
			setActionNotice(t("appsview.LaunchFailed", {
				name: run.displayName,
				message: err instanceof Error ? err.message : t("common.error")
			}), "error", 4e3);
		} finally {
			setBusyRunId(null);
		}
	}, [
		mergeRun,
		openRunInDesktopWindow,
		pushAppsUrl,
		pushRecentApp,
		setActionNotice,
		setState,
		t
	]);
	const visibleApps = useMemo(() => {
		return filterAppsForCatalog(apps, {
			activeAppNames,
			searchQuery,
			walletEnabled
		});
	}, [
		activeAppNames,
		apps,
		searchQuery,
		walletEnabled
	]);
	const browseApps = useMemo(() => {
		return filterAppsForCatalog(apps, { walletEnabled });
	}, [apps, walletEnabled]);
	const handleToggleFavorite = useCallback((appName) => {
		const current = favoriteApps;
		setState("favoriteApps", current.includes(appName) ? current.filter((name) => name !== appName) : [...current, appName]);
	}, [favoriteApps, setState]);
	const handleStopRun = useCallback(async (run) => {
		if (stoppingRunId === run.runId) return;
		setStoppingRunId(run.runId);
		try {
			await client.stopAppRun(run.runId);
			setState("appRuns", appRuns.filter((r) => r.runId !== run.runId));
			if (activeGameRunId === run.runId) setState("activeGameRunId", "");
			setActionNotice(t("appsview.Stopped", { defaultValue: `${run.displayName} stopped.` }), "success", 2600);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setActionNotice(t("appsview.StopFailed", { defaultValue: `Could not stop ${run.displayName}: ${message}` }), "error", 4e3);
		} finally {
			setStoppingRunId(null);
		}
	}, [
		activeGameRunId,
		appRuns,
		setActionNotice,
		setState,
		stoppingRunId,
		t
	]);
	const handleToggleAppWindowAlwaysOnTop = useCallback(async (windowRecord) => {
		if (busyAppWindowId === windowRecord.id) return;
		const next = !windowRecord.alwaysOnTop;
		setBusyAppWindowId(windowRecord.id);
		try {
			if (windowRecord.kind === "managed") {
				if (!(await invokeDesktopBridgeRequest({
					rpcMethod: "desktopSetManagedWindowAlwaysOnTop",
					ipcChannel: "desktop:setManagedWindowAlwaysOnTop",
					params: {
						id: windowRecord.id,
						flag: next
					}
				}))?.success) throw new Error("Window is no longer open.");
			} else if (!(await invokeDesktopBridgeRequest({
				rpcMethod: "canvasSetAlwaysOnTop",
				ipcChannel: "canvas:setAlwaysOnTop",
				params: {
					id: windowRecord.id,
					flag: next
				}
			}))?.success) throw new Error("Window is no longer open.");
			setAppWindows((current) => current.map((item) => item.id === windowRecord.id ? {
				...item,
				alwaysOnTop: next
			} : item));
			setActionNotice(next ? t("appsview.AppWindowPinned", {
				defaultValue: `${windowRecord.displayName} will stay on top.`,
				name: windowRecord.displayName
			}) : t("appsview.AppWindowNormal", {
				defaultValue: `${windowRecord.displayName} is a normal window.`,
				name: windowRecord.displayName
			}), "success", 2200);
		} catch (err) {
			setActionNotice(t("appsview.AppWindowPinFailed", {
				defaultValue: `Could not update ${windowRecord.displayName}: ${err instanceof Error ? err.message : t("common.error")}`,
				name: windowRecord.displayName,
				message: err instanceof Error ? err.message : t("common.error")
			}), "error", 3600);
		} finally {
			setBusyAppWindowId(null);
		}
	}, [
		busyAppWindowId,
		setActionNotice,
		t
	]);
	const appsSidebar = (0, import_jsx_runtime.jsx)(AppsSidebar, {
		apps,
		browseApps,
		runs: sortedRuns,
		activeAppNames,
		favoriteAppNames,
		selectedAppName: activeGameRun?.appName ?? null,
		collapsed: sidebarCollapsed,
		onCollapsedChange: handleSidebarCollapsedChange,
		width: sidebarWidth,
		onWidthChange: handleSidebarWidthChange,
		minWidth: APPS_SIDEBAR_MIN_WIDTH,
		maxWidth: APPS_SIDEBAR_MAX_WIDTH,
		onLaunchApp: (app) => void handleLaunch(app),
		onOpenRun: (run) => void handleOpenRun(run)
	});
	return (0, import_jsx_runtime.jsx)(PageLayout, {
		className: "h-full bg-transparent",
		"data-testid": "apps-shell",
		sidebar: appsSidebar,
		contentInnerClassName: "w-full",
		contentClassName: "![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "device-layout mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6",
			children: [
				appWindows.length > 0 ? (0, import_jsx_runtime.jsx)("section", {
					"data-testid": "app-window-controls",
					className: "flex flex-wrap items-center gap-2",
					children: appWindows.map((windowRecord) => {
						const busy = busyAppWindowId === windowRecord.id;
						return (0, import_jsx_runtime.jsxs)("div", {
							className: "inline-flex min-w-0 items-center gap-2 rounded-full border border-border/55 bg-card/70 px-3 py-1.5 text-xs text-muted",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "max-w-44 truncate font-medium text-foreground",
								children: windowRecord.displayName
							}), (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
								onClick: () => void handleToggleAppWindowAlwaysOnTop(windowRecord),
								disabled: busy,
								"aria-label": windowRecord.alwaysOnTop ? `Let ${windowRecord.displayName} act like a normal window` : `Keep ${windowRecord.displayName} on top`,
								children: [windowRecord.alwaysOnTop ? (0, import_jsx_runtime.jsx)(PinOff, {
									className: "h-3.5 w-3.5",
									"aria-hidden": "true"
								}) : (0, import_jsx_runtime.jsx)(Pin, {
									className: "h-3.5 w-3.5",
									"aria-hidden": "true"
								}), windowRecord.alwaysOnTop ? "Normal" : "On top"]
							})]
						}, windowRecord.id);
					})
				}) : null,
				hasActiveRun ? (0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-wrap items-center justify-between gap-3",
					children: (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rounded-full border border-ok/35 bg-ok/10 px-3 py-1.5 text-xs-tight font-medium text-ok transition-colors hover:bg-ok/15",
						onClick: handleOpenCurrentGame,
						children: hasCurrentGame ? "Live viewer" : "Active run"
					})
				}) : null,
				appsDetailsSlug ? (0, import_jsx_runtime.jsx)(AppDetailsView, {
					slug: appsDetailsSlug,
					onLaunched: (launch) => {
						setAppsDetailsSlug(null);
						if (launch.mode === "window") pushAppsUrl();
					}
				}) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(RunningAppsRow, {
					runs: sortedRuns,
					catalogApps: apps,
					busyRunId,
					onOpenRun: (run) => void handleOpenRun(run),
					onStopRun: (run) => void handleStopRun(run),
					stoppingRunId
				}), (0, import_jsx_runtime.jsx)(AppsCatalogGrid, {
					activeAppNames,
					error,
					favoriteAppNames,
					loading,
					searchQuery,
					visibleApps,
					onLaunch: (app) => void handleLaunch(app),
					onToggleFavorite: handleToggleFavorite
				})] })
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/AppsPageView.js
var AppsPageView_exports = /* @__PURE__ */ __exportAll({ AppsPageView: () => AppsPageView });
function AppsPageView({ inModal, appsView: AppsViewRenderer = AppsView, gameView: GameViewRenderer = GameView } = {}) {
	const { appRuns, appsSubTab, activeGameRunId, setState } = useApp();
	const hasActiveGame = activeGameRunId.trim().length > 0;
	const activeGameRun = hasActiveGame ? appRuns.find((run) => run.runId === activeGameRunId) : void 0;
	useEffect(() => {
		if (appsSubTab !== "games" || !activeGameRun) return;
		const slug = getAppSlug(activeGameRun.appName);
		try {
			const currentPath = getWindowNavigationPath();
			const expected = `/apps/${slug}`;
			if (currentPath !== expected) if (shouldUseHashNavigation()) window.location.hash = expected;
			else window.history.replaceState(null, "", expected);
		} catch {}
	}, [appsSubTab, activeGameRun]);
	useEffect(() => {
		if (appsSubTab === "games" && !hasActiveGame) setState("appsSubTab", "browse");
	}, [
		appsSubTab,
		hasActiveGame,
		setState
	]);
	if (appsSubTab === "games" && hasActiveGame) return (0, import_jsx_runtime.jsx)(GameViewRenderer, {});
	if (inModal) return (0, import_jsx_runtime.jsx)("div", {
		className: "settings-content-area",
		style: {
			"--accent": "var(--section-accent-apps, #10b981)",
			"--surface": "rgba(255, 255, 255, 0.06)",
			"--s-accent": "#10b981",
			"--s-text-txt": "#10b981",
			"--s-accent-glow": "rgba(16, 185, 129, 0.35)",
			"--s-accent-subtle": "rgba(16, 185, 129, 0.12)",
			"--s-grid-line": "rgba(16, 185, 129, 0.02)",
			"--s-glow-edge": "rgba(16, 185, 129, 0.08)"
		},
		children: (0, import_jsx_runtime.jsx)("div", {
			className: "settings-section-pane pt-4",
			children: (0, import_jsx_runtime.jsx)(AppsViewRenderer, {})
		})
	});
	return (0, import_jsx_runtime.jsx)(AppsViewRenderer, {});
}

//#endregion
export { shouldUseEmbeddedAppViewer as C, resolveViewerReadyEventType as S, saveChatSidebarVisibility as _, DESKTOP_GAME_CLICK_AUDIT as a, resolveEmbeddedViewerUrl as b, buildDisconnectedSessionState as c, getAppDetailExtension as d, registerDetailExtension as f, loadChatSidebarVisibility as g, isWidgetVisible as h, useRegistryCatalog as i, getAppOperatorSurface as l, CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY as m, AppsPageView_exports as n, DesktopGameWindowControls as o, APPS_SECTION_VISIBILITY_KEY as p, AppsView as r, GameView as s, AppsPageView as t, registerOperatorSurface as u, widgetVisibilityKey as v, resolvePostMessageTargetOrigin as x, buildViewerSessionKey as y };