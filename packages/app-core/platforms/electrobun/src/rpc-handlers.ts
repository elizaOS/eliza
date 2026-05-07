/**
 * RPC Handler Registration for Electrobun
 *
 * Maps each RPC request method from ElizaDesktopRPCSchema.bun.requests
 * to the corresponding native module method. This is the Bun-side
 * equivalent of main-process request handler registration.
 *
 * Called once during app startup after the BrowserView is created.
 */

import * as fs from "node:fs";
import { logger } from "@elizaos/core";
import { Utils } from "electrobun/bun";
import { setAgentReady } from "./agent-ready-state";
import { resolveDesktopRuntimeMode } from "./api-base";
import { showBackgroundNoticeOnce } from "./background-notice";
import { getBrandConfig } from "./brand-config";
import { postCloudDisconnectFromMain } from "./cloud-disconnect-from-main";
import { desktopHttpRequest } from "./desktop-http-request";
import { formatRendererDiagnosticLine } from "./diagnostic-format";
import { getFloatingChatManager } from "./floating-chat-window";
import { getAgentManager } from "./native/agent";
import { getBrowserWorkspaceManager } from "./native/browser-workspace";
import { getCameraManager } from "./native/camera";
import { getCanvasManager } from "./native/canvas";
import {
	scanAndValidateProviderCredentials,
	scanProviderCredentials,
} from "./native/credentials";
import { getDesktopManager } from "./native/desktop";
import type { NativeEditorId } from "./native/editor-bridge";
import { getEditorBridge } from "./native/editor-bridge";
import { getFileWatcher } from "./native/file-watcher";
import { getGatewayDiscovery } from "./native/gateway";
import { getGpuWindowManager } from "./native/gpu-window";
import { getLocationManager } from "./native/location";
import { getMusicPlayerManager } from "./native/music-player";
import { getPermissionManager } from "./native/permissions";
import type { AllPermissionsState } from "./native/permissions-shared";
import { getScreenCaptureManager } from "./native/screencapture";
import {
	getStewardStatus,
	isStewardLocalEnabled,
	resetSteward,
	restartSteward,
	startSteward,
} from "./native/steward";
import { getSwabbleManager } from "./native/swabble";
import { getTalkModeManager } from "./native/talkmode";
import {
	buildRuntimePermissionUnavailableState,
	fetchRuntimePermissionState,
	isRuntimePermissionId,
	mergeRuntimePermissionStates,
} from "./runtime-permissions";
import { isDetachedSurface } from "./surface-windows";
import type { SendToWebview } from "./types.js";

function normalizeRendererRoutePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
		throw new Error("desktopOpenAppWindow path must be a renderer route.");
	}
	return trimmed;
}

/** Push current OS permission states to the agent REST API in-process. */
async function syncPermissionsToRestApi(
	portOverride?: number | null,
	nativePermissions?: AllPermissionsState,
): Promise<void> {
	const port = portOverride ?? getAgentManager().getPort();
	if (!port) return;
	try {
		const permissions = await mergeRuntimePermissionStates(
			port,
			nativePermissions ?? (await getPermissionManager().checkAllPermissions()),
		);
		await fetch(`http://127.0.0.1:${port}/api/permissions/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ permissions }),
		});
	} catch (error) {
		logger.warn(
			`[Permissions] Failed to sync permission state to runtime: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Structural type for the Electrobun RPC instance used in rpc-handlers.
 * The createRPC return value exposes setRequestHandler, but the base
 * RPCWithTransport interface does not include it.
 *
 * `any` is an explicit escape hatch here: the individual handlers are fully
 * typed at their call-sites via `Parameters<typeof manager.method>[0]`, so
 * type safety lives in the concrete handler definitions, not this wrapper.
 */
type ElectrobunRpcWithHandlers = {
	// biome-ignore lint/suspicious/noExplicitAny: Electrobun doesn't export a typed setRequestHandler interface; individual handlers are typed at call-sites
	setRequestHandler?: (handlers: Record<string, (params: any) => any>) => void;
	// biome-ignore lint/suspicious/noExplicitAny: bun→renderer request proxy; methods typed at call-sites
	request?: Record<string, (params: any) => Promise<any>>;
};

export {
	formatRendererDiagnosticLine,
	redactDiagnosticUrl,
} from "./diagnostic-format";

/**
 * Register all RPC request handlers on the given rpc instance.
 *
 * Each handler receives typed params and must return the typed response
 * matching ElizaDesktopRPCSchema.bun.requests[method].
 */
export function registerRpcHandlers(
	rpc: ElectrobunRpcWithHandlers | null | undefined,
	sendToWebview: SendToWebview,
): void {
	if (!rpc) {
		logger.error("[RPC] No RPC instance provided");
		return;
	}

	const agent = getAgentManager();
	const browserWorkspace = getBrowserWorkspaceManager();
	const rendererRequest = rpc?.request;
	if (rendererRequest) {
		browserWorkspace.setRendererCaller({
			evaluate: (params) =>
				rendererRequest.browserWorkspaceRendererEvaluate(params),
			getTabRect: (params) =>
				rendererRequest.browserWorkspaceRendererGetTabRect(params),
		});
	} else {
		browserWorkspace.setRendererCaller(null);
	}
	const camera = getCameraManager();
	const canvas = getCanvasManager();
	const desktop = getDesktopManager();
	const editorBridge = getEditorBridge();
	const fileWatcher = getFileWatcher();
	const floatingChat = getFloatingChatManager();
	const gateway = getGatewayDiscovery();
	const gpuWindow = getGpuWindowManager();
	const location = getLocationManager();
	const permissions = getPermissionManager();
	const screencapture = getScreenCaptureManager();
	const swabble = getSwabbleManager();
	const talkmode = getTalkModeManager();
	const musicPlayer = getMusicPlayerManager();

	rpc?.setRequestHandler?.({
		// ---- Agent ----
		agentStart: async () => {
			const status = await agent.start();
			if (status.state === "running") {
				setAgentReady(true);
			}
			return status;
		},
		agentStop: async () => {
			await agent.stop();
			setAgentReady(false);
			return { ok: true };
		},
		agentRestart: async () => {
			const status = await agent.restart();
			setAgentReady(status.state === "running");
			return status;
		},
		agentRestartClearLocalDb: async () => {
			logger.info("[RPC][reset] agentRestartClearLocalDb invoked");
			try {
				const status = await agent.restartClearingLocalDb();
				logger.info(
					`[RPC][reset] agentRestartClearLocalDb done state=${status.state} port=${status.port ?? "none"}`,
				);
				setAgentReady(status.state === "running");
				return status;
			} catch (err) {
				logger.error(
					`[RPC][reset] agentRestartClearLocalDb failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				throw err;
			}
		},
		agentStatus: async () => agent.getStatus(),
		agentInspectExistingInstall: async () => agent.inspectExistingInstall(),
		/** Renderer `fetch` after native dialogs can stall; main POST matches menu reset pattern. */
		agentPostCloudDisconnect: async (
			params?: { apiBase?: string; bearerToken?: string } | null,
		) => {
			try {
				return await postCloudDisconnectFromMain({
					apiBaseOverride: params?.apiBase ?? null,
					bearerTokenOverride: params?.bearerToken ?? null,
				});
			} catch (err) {
				logger.error(
					`[RPC] agentPostCloudDisconnect failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				throw err;
			}
		},
		/** Native confirm + main-process POST (renderer bridge/fetch can stall after a sheet). */
		agentCloudDisconnectWithConfirm: async (
			params?: { apiBase?: string; bearerToken?: string } | null,
		) => {
			const box = await desktop.showMessageBox({
				type: "warning",
				title: "Disconnect from Eliza Cloud",
				message: "The agent will need a local AI provider to continue working.",
				buttons: ["Disconnect", "Cancel"],
				defaultId: 0,
				cancelId: 1,
			});
			const raw =
				box && typeof box === "object" && "response" in box
					? (box as { response: unknown }).response
					: box;
			const response =
				typeof raw === "number" && Number.isFinite(raw)
					? raw
					: typeof raw === "bigint"
						? Number(raw)
						: 1;
			if (response !== 0) {
				return { cancelled: true as const };
			}
			try {
				return await postCloudDisconnectFromMain({
					apiBaseOverride: params?.apiBase ?? null,
					bearerTokenOverride: params?.bearerToken ?? null,
				});
			} catch (err) {
				logger.error(
					`[RPC] agentCloudDisconnectWithConfirm failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				throw err;
			}
		},

		desktopGetRuntimeMode: async () => {
			const runtimeMode = resolveDesktopRuntimeMode(
				process.env as Record<string, string | undefined>,
			);
			return {
				mode: runtimeMode.mode,
				externalApiBase: runtimeMode.externalApi.base,
				externalApiSource: runtimeMode.externalApi.source,
			};
		},
		desktopHttpRequest,

		// ---- Renderer diagnostics ----
		rendererReportDiagnostic: async (
			params?: {
				level?: "log" | "info" | "warn" | "error";
				source?: string;
				message?: string;
				details?: unknown;
			} | null,
		) => {
			const level = params?.level ?? "log";
			const line = formatRendererDiagnosticLine(params);
			switch (level) {
				case "error":
					logger.error(line);
					break;
				case "warn":
					logger.warn(line);
					break;
				case "info":
					logger.info(line);
					break;
				default:
					logger.info(line);
					break;
			}
			return { ok: true };
		},

		// ---- Desktop: Tray ----
		desktopCreateTray: async (
			params: Parameters<typeof desktop.createTray>[0],
		) => desktop.createTray(params),
		desktopUpdateTray: async (
			params: Parameters<typeof desktop.updateTray>[0],
		) => desktop.updateTray(params),
		desktopDestroyTray: async () => desktop.destroyTray(),
		desktopSetTrayMenu: async (
			params: Parameters<typeof desktop.setTrayMenu>[0],
		) => desktop.setTrayMenu(params),

		// ---- Desktop: Shortcuts ----
		desktopRegisterShortcut: async (
			params: Parameters<typeof desktop.registerShortcut>[0],
		) => desktop.registerShortcut(params),
		desktopUnregisterShortcut: async (
			params: Parameters<typeof desktop.unregisterShortcut>[0],
		) => desktop.unregisterShortcut(params),
		desktopUnregisterAllShortcuts: async () => desktop.unregisterAllShortcuts(),
		desktopIsShortcutRegistered: async (
			params: Parameters<typeof desktop.isShortcutRegistered>[0],
		) => desktop.isShortcutRegistered(params),

		// ---- Desktop: Auto Launch ----
		desktopSetAutoLaunch: async (
			params: Parameters<typeof desktop.setAutoLaunch>[0],
		) => desktop.setAutoLaunch(params),
		desktopGetAutoLaunchStatus: async () => desktop.getAutoLaunchStatus(),

		// ---- Desktop: Window ----
		desktopSetWindowOptions: async (
			params: Parameters<typeof desktop.setWindowOptions>[0],
		) => desktop.setWindowOptions(params),
		desktopGetWindowBounds: async () => desktop.getWindowBounds(),
		desktopSetWindowBounds: async (
			params: Parameters<typeof desktop.setWindowBounds>[0],
		) => desktop.setWindowBounds(params),
		desktopMinimizeWindow: async () => desktop.minimizeWindow(),
		desktopUnminimizeWindow: async () => desktop.unminimizeWindow(),
		desktopMaximizeWindow: async () => desktop.maximizeWindow(),
		desktopUnmaximizeWindow: async () => desktop.unmaximizeWindow(),
		desktopCloseWindow: async () => desktop.closeWindow(),
		desktopShowWindow: async () => desktop.showWindow(),
		desktopHideWindow: async () => desktop.hideWindow(),
		desktopFocusWindow: async () => desktop.focusWindow(),
		desktopIsWindowMaximized: async () => desktop.isWindowMaximized(),
		desktopIsWindowMinimized: async () => desktop.isWindowMinimized(),
		desktopIsWindowVisible: async () => desktop.isWindowVisible(),
		desktopIsWindowFocused: async () => desktop.isWindowFocused(),
		desktopSetAlwaysOnTop: async (
			params: Parameters<typeof desktop.setAlwaysOnTop>[0],
		) => desktop.setAlwaysOnTop(params),
		desktopSetFullscreen: async (
			params: Parameters<typeof desktop.setFullscreen>[0],
		) => desktop.setFullscreen(params),
		desktopSetOpacity: async (
			params: Parameters<typeof desktop.setOpacity>[0],
		) => desktop.setOpacity(params),

		// ---- Desktop: Notifications ----
		desktopShowNotification: async (
			params: Parameters<typeof desktop.showNotification>[0],
		) => desktop.showNotification(params),
		desktopCloseNotification: async (
			params: Parameters<typeof desktop.closeNotification>[0],
		) => desktop.closeNotification(params),
		desktopShowBackgroundNotice: async () => ({
			shown: showBackgroundNoticeOnce({
				fileSystem: fs,
				userDataDir: Utils.paths.userData,
				showNotification: (options) => {
					Utils.showNotification(options);
				},
			}),
		}),

		// ---- Desktop: Power ----
		desktopGetPowerState: async () => desktop.getPowerState(),

		// ---- Desktop: App ----
		desktopQuit: async () => desktop.quit(),
		desktopRelaunch: async () => desktop.relaunch(),
		desktopApplyUpdate: async () => desktop.applyUpdate(),
		desktopCheckForUpdates: async () => desktop.checkForUpdates(),
		desktopGetUpdaterState: async () => desktop.getUpdaterState(),
		desktopGetVersion: async () => desktop.getVersion(),
		desktopGetBuildInfo: async () => desktop.getBuildInfo(),
		desktopIsPackaged: async () => desktop.isPackaged(),
		desktopGetDockIconVisibility: async () => desktop.getDockIconVisibility(),
		desktopSetDockIconVisibility: async (
			params: Parameters<typeof desktop.setDockIconVisibility>[0],
		) => desktop.setDockIconVisibility(params),
		desktopGetPath: async (params: Parameters<typeof desktop.getPath>[0]) =>
			desktop.getPath(params),
		desktopGetStartupDiagnostics: async () => desktop.getStartupDiagnostics(),
		desktopOpenLogsFolder: async () => desktop.openLogsFolder(),
		desktopCreateBugReportBundle: async (
			params: Parameters<typeof desktop.createBugReportBundle>[0],
		) => desktop.createBugReportBundle(params),
		desktopBeep: async () => desktop.beep(),
		desktopShowSelectionContextMenu: async (
			params: Parameters<typeof desktop.showSelectionContextMenu>[0],
		) => desktop.showSelectionContextMenu(params),
		desktopGetSessionSnapshot: async (
			params: Parameters<typeof desktop.getSessionSnapshot>[0],
		) => desktop.getSessionSnapshot(params),
		desktopClearSessionData: async (
			params: Parameters<typeof desktop.clearSessionData>[0],
		) => desktop.clearSessionData(params),
		desktopGetWebGpuBrowserStatus: async () => desktop.getWebGpuBrowserStatus(),
		desktopOpenReleaseNotesWindow: async (
			params: Parameters<typeof desktop.openReleaseNotesWindow>[0],
		) => desktop.openReleaseNotesWindow(params),
		desktopOpenSettingsWindow: async (
			params: { tabHint?: string } | undefined,
		) => {
			desktop.openSettings(params?.tabHint);
		},
		desktopOpenSurfaceWindow: async (params: {
			surface:
				| "chat"
				| "browser"
				| "release"
				| "triggers"
				| "plugins"
				| "connectors"
				| "cloud";
			browse?: string;
			alwaysOnTop?: boolean;
		}) => {
			if (!isDetachedSurface(params.surface)) {
				return null;
			}
			return desktop.openSurfaceWindow(
				params.surface,
				params.surface === "browser" ? params.browse : undefined,
				params.alwaysOnTop === true,
			);
		},
		desktopOpenAppWindow: async (params: {
			slug?: string;
			title: string;
			path: string;
			alwaysOnTop?: boolean;
		}) =>
			desktop.openAppWindow({
				slug:
					typeof params.slug === "string" && params.slug.length > 0
						? params.slug
						: undefined,
				title: params.title.trim() || getBrandConfig().appName,
				path: normalizeRendererRoutePath(params.path),
				alwaysOnTop: params.alwaysOnTop === true,
			}),
		desktopSetManagedWindowAlwaysOnTop: async (params: {
			id: string;
			flag: boolean;
		}) => ({
			success: desktop.setManagedWindowAlwaysOnTop(params.id, params.flag),
		}),

		// ---- Browser Workspace ----
		browserWorkspaceGetSnapshot: async () => ({
			mode: "desktop" as const,
			tabs: (await browserWorkspace.listTabs()).tabs,
		}),
		browserWorkspaceOpenTab: async (
			params?: {
				url?: string;
				title?: string;
				show?: boolean;
				partition?: string;
				kind?: "internal" | "standard";
				width?: number;
				height?: number;
			} | null,
		) => ({
			tab: await browserWorkspace.openTab({
				url: params?.url,
				title: params?.title,
				show: params?.show,
				partition: params?.partition,
				kind: params?.kind,
				width: params?.width,
				height: params?.height,
			}),
		}),
		browserWorkspaceNavigateTab: async (
			params?: { id?: string; url?: string } | null,
		) => {
			const id = params?.id?.trim();
			const url = params?.url?.trim();
			if (!id || !url) {
				throw new Error("browser workspace navigate requires id and url");
			}
			const tab = await browserWorkspace.navigateTab({ id, url });
			if (!tab) {
				throw new Error(`browser workspace tab not found: ${id}`);
			}
			return { tab };
		},
		browserWorkspaceShowTab: async (params?: { id?: string } | null) => {
			const id = params?.id?.trim();
			if (!id) {
				throw new Error("browser workspace show requires id");
			}
			const tab = await browserWorkspace.showTab({ id });
			if (!tab) {
				throw new Error(`browser workspace tab not found: ${id}`);
			}
			return { tab };
		},
		browserWorkspaceHideTab: async (params?: { id?: string } | null) => {
			const id = params?.id?.trim();
			if (!id) {
				throw new Error("browser workspace hide requires id");
			}
			const tab = await browserWorkspace.hideTab({ id });
			if (!tab) {
				throw new Error(`browser workspace tab not found: ${id}`);
			}
			return { tab };
		},
		browserWorkspaceCloseTab: async (params?: { id?: string } | null) => {
			const id = params?.id?.trim();
			if (!id) {
				throw new Error("browser workspace close requires id");
			}
			return { closed: await browserWorkspace.closeTab({ id }) };
		},
		browserWorkspaceSnapshotTab: async (params?: { id?: string } | null) => {
			const id = params?.id?.trim();
			if (!id) {
				throw new Error("browser workspace snapshot requires id");
			}
			const snapshot = await browserWorkspace.snapshotTab({ id });
			if (!snapshot) {
				throw new Error("browser workspace snapshot unavailable");
			}
			return snapshot;
		},

		// ---- Desktop: Screen ----
		desktopGetPrimaryDisplay: async () => desktop.getPrimaryDisplay(),
		desktopGetAllDisplays: async () => desktop.getAllDisplays(),
		desktopGetCursorPosition: async () => desktop.getCursorPosition(),

		// ---- Desktop: Message Box ----
		desktopShowMessageBox: async (
			params: Parameters<typeof desktop.showMessageBox>[0],
		) => desktop.showMessageBox(params),

		// ---- Desktop: Clipboard ----
		desktopWriteToClipboard: async (
			params: Parameters<typeof desktop.writeToClipboard>[0],
		) => desktop.writeToClipboard(params),
		desktopReadFromClipboard: async () => desktop.readFromClipboard(),
		desktopClearClipboard: async () => desktop.clearClipboard(),
		desktopClipboardAvailableFormats: async () =>
			desktop.clipboardAvailableFormats(),

		// ---- Desktop: Shell ----
		desktopOpenExternal: async (
			params: Parameters<typeof desktop.openExternal>[0],
		) => desktop.openExternal(params),
		desktopShowItemInFolder: async (
			params: Parameters<typeof desktop.showItemInFolder>[0],
		) => desktop.showItemInFolder(params),
		desktopOpenPath: async (params: Parameters<typeof desktop.openPath>[0]) =>
			desktop.openPath(params),

		// ---- Desktop: File Dialogs ----
		desktopShowOpenDialog: async (
			params: Parameters<typeof desktop.showOpenDialog>[0],
		) => desktop.showOpenDialog(params),
		desktopShowSaveDialog: async (
			params: Parameters<typeof desktop.showSaveDialog>[0],
		) => desktop.showSaveDialog(params),

		// ---- Gateway ----
		gatewayStartDiscovery: async (
			params: Parameters<typeof gateway.startDiscovery>[0] | undefined,
		) => gateway.startDiscovery(params || undefined),
		gatewayStopDiscovery: async () => gateway.stopDiscovery(),
		gatewayIsDiscovering: async () => ({
			isDiscovering: gateway.isDiscoveryActive(),
		}),
		gatewayGetDiscoveredGateways: async () => ({
			gateways: gateway.getDiscoveredGateways(),
		}),

		// ---- Permissions ----
		permissionsCheck: async (params: {
			id: Parameters<typeof permissions.checkPermission>[0];
			forceRefresh?: boolean;
		}) => {
			if (isRuntimePermissionId(params.id)) {
				const runtimePermission = await fetchRuntimePermissionState(
					agent.getPort(),
					params.id,
				);
				return (
					runtimePermission ??
					buildRuntimePermissionUnavailableState(
						params.id,
						`${getBrandConfig().appName} runtime is unavailable, so website blocking permission cannot be checked from desktop right now.`,
					)
				);
			}
			return permissions.checkPermission(params.id, params.forceRefresh);
		},
		permissionsCheckFeature: async (params: {
			featureId: Parameters<typeof permissions.checkFeaturePermissions>[0];
		}) => {
			if (params.featureId === "website-blocker") {
				const runtimePermission = await fetchRuntimePermissionState(
					agent.getPort(),
					"website-blocking",
				);
				const granted =
					runtimePermission?.status === "granted" ||
					runtimePermission?.status === "not-applicable";
				return {
					granted,
					missing: granted ? [] : ["website-blocking"],
				};
			}
			return permissions.checkFeaturePermissions(params.featureId);
		},
		permissionsRequest: async (params: {
			id: Parameters<typeof permissions.requestPermission>[0];
		}) => {
			if (isRuntimePermissionId(params.id)) {
				const runtimePermission = await fetchRuntimePermissionState(
					agent.getPort(),
					params.id,
					"request",
				);
				const nextPermissions = await permissions.checkAllPermissions();
				await syncPermissionsToRestApi(agent.getPort(), nextPermissions);
				return (
					runtimePermission ??
					buildRuntimePermissionUnavailableState(
						params.id,
						`${getBrandConfig().appName} runtime is unavailable, so website blocking permission cannot be requested from desktop right now.`,
					)
				);
			}
			const result = await permissions.requestPermission(params.id);
			await syncPermissionsToRestApi(
				agent.getPort(),
				await permissions.checkAllPermissions(),
			);
			return result;
		},
		permissionsGetAll: async (
			params: { forceRefresh?: boolean } | undefined,
		) => {
			const result = await mergeRuntimePermissionStates(
				agent.getPort(),
				await permissions.checkAllPermissions(params?.forceRefresh),
			);
			await syncPermissionsToRestApi(agent.getPort(), result);
			return result;
		},
		permissionsGetPlatform: async () => process.platform,
		permissionsIsShellEnabled: async () => permissions.isShellEnabled(),
		permissionsSetShellEnabled: async (params: { enabled: boolean }) => {
			permissions.setShellEnabled(params.enabled);
			return permissions.checkPermission("shell");
		},
		permissionsClearCache: async () => permissions.clearCache(),
		permissionsOpenSettings: async (params: {
			id: Parameters<typeof permissions.openSettings>[0];
		}) => {
			if (isRuntimePermissionId(params.id)) {
				const runtimePermission = await fetchRuntimePermissionState(
					agent.getPort(),
					params.id,
					"open-settings",
				);
				if (runtimePermission) {
					return;
				}
				throw new Error(
					`${getBrandConfig().appName} runtime is unavailable, so website blocking permission help could not be opened from desktop.`,
				);
			}
			return permissions.openSettings(params.id);
		},

		// ---- Location ----
		locationGetCurrentPosition: async () => location.getCurrentPosition(),
		locationWatchPosition: async (
			params: Parameters<typeof location.watchPosition>[0],
		) => location.watchPosition(params),
		locationClearWatch: async (
			params: Parameters<typeof location.clearWatch>[0],
		) => location.clearWatch(params),
		locationGetLastKnownLocation: async () => location.getLastKnownLocation(),

		// ---- Camera ----
		cameraGetDevices: async () => camera.getDevices(),
		cameraStartPreview: async (
			params: Parameters<typeof camera.startPreview>[0],
		) => camera.startPreview(params),
		cameraStopPreview: async () => camera.stopPreview(),
		cameraSwitchCamera: async (
			params: Parameters<typeof camera.switchCamera>[0],
		) => camera.switchCamera(params),
		cameraCapturePhoto: async () => camera.capturePhoto(),
		cameraStartRecording: async () => camera.startRecording(),
		cameraStopRecording: async () => camera.stopRecording(),
		cameraGetRecordingState: async () => camera.getRecordingState(),
		cameraCheckPermissions: async () => camera.checkPermissions(),
		cameraRequestPermissions: async () => camera.requestPermissions(),

		// ---- Canvas ----
		canvasCreateWindow: async (
			params: Parameters<typeof canvas.createWindow>[0],
		) => canvas.createWindow(params),
		canvasDestroyWindow: async (
			params: Parameters<typeof canvas.destroyWindow>[0],
		) => canvas.destroyWindow(params),
		canvasNavigate: async (params: Parameters<typeof canvas.navigate>[0]) =>
			canvas.navigate(params),
		canvasEval: async (params: Parameters<typeof canvas.eval>[0]) =>
			canvas.eval(params),
		canvasSnapshot: async (params: Parameters<typeof canvas.snapshot>[0]) =>
			canvas.snapshot(params),
		canvasA2uiPush: async (params: Parameters<typeof canvas.a2uiPush>[0]) =>
			canvas.a2uiPush(params),
		canvasA2uiReset: async (params: Parameters<typeof canvas.a2uiReset>[0]) =>
			canvas.a2uiReset(params),
		canvasShow: async (params: Parameters<typeof canvas.show>[0]) =>
			canvas.show(params),
		canvasHide: async (params: Parameters<typeof canvas.hide>[0]) =>
			canvas.hide(params),
		canvasResize: async (params: Parameters<typeof canvas.resize>[0]) =>
			canvas.resize(params),
		canvasFocus: async (params: Parameters<typeof canvas.focus>[0]) =>
			canvas.focus(params),
		canvasGetBounds: async (params: Parameters<typeof canvas.getBounds>[0]) =>
			canvas.getBounds(params),
		canvasSetBounds: async (params: Parameters<typeof canvas.setBounds>[0]) =>
			canvas.setBounds(params),
		canvasSetAlwaysOnTop: async (
			params: Parameters<typeof canvas.setAlwaysOnTop>[0],
		) => canvas.setAlwaysOnTop(params),
		canvasListWindows: async () => canvas.listWindows(),

		// ---- Game ----
		gameOpenWindow: async (
			params: Parameters<typeof canvas.openGameWindow>[0],
		) => canvas.openGameWindow(params),

		// ---- Screencapture ----
		screencaptureGetSources: async () => screencapture.getSources(),
		screencaptureTakeScreenshot: async () => screencapture.takeScreenshot(),
		screencaptureCaptureWindow: async (
			params: Parameters<typeof screencapture.captureWindow>[0],
		) => screencapture.captureWindow(params),
		screencaptureStartRecording: async () => screencapture.startRecording(),
		screencaptureStopRecording: async () => screencapture.stopRecording(),
		screencapturePauseRecording: async () => screencapture.pauseRecording(),
		screencaptureResumeRecording: async () => screencapture.resumeRecording(),
		screencaptureGetRecordingState: async () =>
			screencapture.getRecordingState(),
		screencaptureStartFrameCapture: async (
			params: Parameters<typeof screencapture.startFrameCapture>[0],
		) => screencapture.startFrameCapture(params),
		screencaptureStopFrameCapture: async () => screencapture.stopFrameCapture(),
		screencaptureIsFrameCaptureActive: async () =>
			screencapture.isFrameCaptureActive(),
		screencaptureSaveScreenshot: async (
			params: Parameters<typeof screencapture.saveScreenshot>[0],
		) => screencapture.saveScreenshot(params),
		screencaptureSwitchSource: async (
			params: Parameters<typeof screencapture.switchSource>[0],
		) => screencapture.switchSource(params),
		screencaptureSetCaptureTarget: async (_params: unknown) => {
			// Legacy compatibility hook. Native frame capture now targets the app
			// window directly, so renderer-side capture target overrides are inert.
			screencapture.setCaptureTarget(null);
			return { available: true };
		},

		// ---- Swabble ----
		swabbleStart: async (params: Parameters<typeof swabble.start>[0]) =>
			swabble.start(params),
		swabbleStop: async () => swabble.stop(),
		swabbleIsListening: async () => swabble.isListening(),
		swabbleGetConfig: async () => swabble.getConfig(),
		swabbleUpdateConfig: async (
			params: Parameters<typeof swabble.updateConfig>[0],
		) => swabble.updateConfig(params),
		swabbleIsWhisperAvailable: async () => swabble.isWhisperAvailableCheck(),
		swabbleAudioChunk: async (
			params: Parameters<typeof swabble.audioChunk>[0],
		) => swabble.audioChunk(params),

		// ---- TalkMode ----
		talkmodeStart: async () => talkmode.start(),
		talkmodeStop: async () => talkmode.stop(),
		talkmodeSpeak: async (params: Parameters<typeof talkmode.speak>[0]) =>
			talkmode.speak(params),
		talkmodeStopSpeaking: async () => talkmode.stopSpeaking(),
		talkmodeGetState: async () => talkmode.getState(),
		talkmodeIsEnabled: async () => talkmode.isEnabled(),
		talkmodeIsSpeaking: async () => talkmode.isSpeaking(),
		talkmodeGetWhisperInfo: async () => talkmode.getWhisperInfo(),
		talkmodeIsWhisperAvailable: async () => talkmode.isWhisperAvailableCheck(),
		talkmodeUpdateConfig: async (
			params: Parameters<typeof talkmode.updateConfig>[0],
		) => talkmode.updateConfig(params),
		talkmodeAudioChunk: async (
			params: Parameters<typeof talkmode.audioChunk>[0],
		) => talkmode.audioChunk(params),

		musicPlayerGetDesktopPlaybackUrls: async (params?: { guildId?: string }) =>
			musicPlayer.getDesktopPlaybackUrls(params),

		// ---- Context Menu ----
		// These forward text selections from the renderer context menu to the agent.
		contextMenuAskAgent: async (params: { text: string }) => {
			sendToWebview("contextMenu:askAgent", { text: params.text });
		},
		contextMenuCreateSkill: async (params: { text: string }) => {
			sendToWebview("contextMenu:createSkill", { text: params.text });
		},
		contextMenuQuoteInChat: async (params: { text: string }) => {
			sendToWebview("contextMenu:quoteInChat", { text: params.text });
		},
		contextMenuSaveAsCommand: async (params: { text: string }) => {
			sendToWebview("contextMenu:saveAsCommand", { text: params.text });
		},

		// ---- Credentials Auto-Detection ----
		credentialsScanProviders: async (params?: { context?: string }) => {
			if (
				!params?.context ||
				!["onboarding", "tray-refresh"].includes(params.context)
			) {
				throw new Error("credentials:scanProviders requires a valid context");
			}
			return { providers: await scanProviderCredentials() };
		},
		credentialsScanAndValidate: async (params?: { context?: string }) => {
			if (
				!params?.context ||
				!["onboarding", "tray-refresh"].includes(params.context)
			) {
				throw new Error("credentialsScanAndValidate requires a valid context");
			}
			return { providers: await scanAndValidateProviderCredentials() };
		},

		// ---- GPU Window ----
		gpuWindowCreate: async (
			params: Parameters<typeof gpuWindow.createWindow>[0],
		) => gpuWindow.createWindow(params),
		gpuWindowDestroy: async (
			params: Parameters<typeof gpuWindow.destroyWindow>[0],
		) => gpuWindow.destroyWindow(params),
		gpuWindowShow: async (params: Parameters<typeof gpuWindow.showWindow>[0]) =>
			gpuWindow.showWindow(params),
		gpuWindowHide: async (params: Parameters<typeof gpuWindow.hideWindow>[0]) =>
			gpuWindow.hideWindow(params),
		gpuWindowSetBounds: async (
			params: Parameters<typeof gpuWindow.setBounds>[0],
		) => gpuWindow.setBounds(params),
		gpuWindowGetInfo: async (params: Parameters<typeof gpuWindow.getInfo>[0]) =>
			gpuWindow.getInfo(params),
		gpuWindowList: async () => gpuWindow.listWindows(),

		// ---- GPU View ----
		gpuViewCreate: async (params: Parameters<typeof gpuWindow.createView>[0]) =>
			gpuWindow.createView(params),
		gpuViewDestroy: async (
			params: Parameters<typeof gpuWindow.destroyView>[0],
		) => gpuWindow.destroyView(params),
		gpuViewSetFrame: async (
			params: Parameters<typeof gpuWindow.setViewFrame>[0],
		) => gpuWindow.setViewFrame(params),
		gpuViewSetTransparent: async (
			params: Parameters<typeof gpuWindow.setViewTransparent>[0],
		) => gpuWindow.setViewTransparent(params),
		gpuViewSetHidden: async (
			params: Parameters<typeof gpuWindow.setViewHidden>[0],
		) => gpuWindow.setViewHidden(params),
		gpuViewGetNativeHandle: async (
			params: Parameters<typeof gpuWindow.getViewNativeHandle>[0],
		) => gpuWindow.getViewNativeHandle(params),
		gpuViewList: async () => gpuWindow.listViews(),

		// ---- Steward Sidecar ----
		stewardGetStatus: async () => getStewardStatus(),
		stewardIsLocalEnabled: async () => ({ enabled: isStewardLocalEnabled() }),
		stewardStart: async () => {
			if (!isStewardLocalEnabled()) {
				return {
					state: "stopped" as const,
					error: "STEWARD_LOCAL not enabled",
				};
			}
			return startSteward();
		},
		stewardRestart: async () => {
			if (!isStewardLocalEnabled()) {
				return {
					state: "stopped" as const,
					error: "STEWARD_LOCAL not enabled",
				};
			}
			return restartSteward();
		},
		stewardReset: async () => {
			if (!isStewardLocalEnabled()) {
				return {
					state: "stopped" as const,
					error: "STEWARD_LOCAL not enabled",
				};
			}
			return resetSteward();
		},

		// ---- Native Editor Bridge ----
		editorBridgeListEditors: async () => ({
			editors: editorBridge.listInstalledEditors(),
		}),
		editorBridgeOpenInEditor: async (params: {
			editorId: NativeEditorId;
			workspacePath: string;
		}) => {
			const session = editorBridge.openInEditor(
				params.editorId,
				params.workspacePath,
			);
			sendToWebview("editorBridge:sessionChanged", session);
			return session;
		},
		editorBridgeGetSession: async () => editorBridge.getActiveEditorSession(),
		editorBridgeClearSession: async () => {
			editorBridge.clearActiveEditorSession();
			sendToWebview("editorBridge:sessionChanged", null);
		},

		// ---- Workspace File Watcher ----
		fileWatcherStart: async (params: { watchPath: string }) => {
			const watchId = fileWatcher.startWatch(params.watchPath, (event) => {
				sendToWebview("fileWatcher:fileChanged", event);
			});
			return { watchId };
		},
		fileWatcherStop: async (params: { watchId: string }) => ({
			stopped: fileWatcher.stopWatch(params.watchId),
		}),
		fileWatcherStopAll: async () => {
			fileWatcher.stopAll();
		},
		fileWatcherList: async () => ({ watches: fileWatcher.listWatches() }),
		fileWatcherGetStatus: async (params: { watchId: string }) =>
			fileWatcher.getWatch(params.watchId),

		// ---- Floating Chat Window ----
		floatingChatOpen: async (
			params: { contextId?: string; x?: number; y?: number } | undefined,
		) => {
			return floatingChat.open(params ?? {});
		},
		floatingChatShow: async () => {
			floatingChat.show();
			return floatingChat.getStatus();
		},
		floatingChatHide: async () => {
			floatingChat.hide();
			return floatingChat.getStatus();
		},
		floatingChatClose: async () => {
			floatingChat.close();
			return floatingChat.getStatus();
		},
		floatingChatSetContext: async (params: { contextId: string | null }) => {
			floatingChat.setContextId(params.contextId);
			return floatingChat.getStatus();
		},
		floatingChatGetStatus: async () => floatingChat.getStatus(),
	});

	logger.info("[RPC] All handlers registered");
}
