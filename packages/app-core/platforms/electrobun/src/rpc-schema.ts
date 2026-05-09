/**
 * elizaOS Desktop RPC Schema for Electrobun
 *
 * Defines the typed RPC contract between the Bun main process and
 * the webview renderer. Replaces the stringly-typed legacy desktop channel surface
 * with compile-time safe typed RPC.
 *
 * Schema structure (from Electrobun's perspective):
 * - bun.requests: Handlers the Bun side implements (webview calls these)
 * - bun.messages: Messages the Bun side receives (webview sends these)
 * - webview.requests: Handlers the webview implements (Bun calls these)
 * - webview.messages: Messages the webview receives (Bun sends these)
 */

import type {
	BrowserWorkspaceSnapshot,
	BrowserWorkspaceTab,
	NavigateBrowserWorkspaceTabRequest,
	OpenBrowserWorkspaceTabRequest,
} from "@elizaos/plugin-browser";
import type { RPCSchema } from "electrobun/bun";

// ============================================================================
// Shared Types
// ============================================================================

// -- Desktop --
export type ExistingElizaInstallSource =
	| "config-path-env"
	| "state-dir-env"
	| "default-state-dir";

export interface ExistingElizaInstallInfo {
	detected: boolean;
	stateDir: string;
	configPath: string;
	configExists: boolean;
	stateDirExists: boolean;
	hasStateEntries: boolean;
	source: ExistingElizaInstallSource;
}

export interface TrayMenuItem {
	id: string;
	label?: string;
	type?: "normal" | "separator" | "checkbox" | "radio";
	checked?: boolean;
	enabled?: boolean;
	visible?: boolean;
	icon?: string;
	accelerator?: string;
	submenu?: TrayMenuItem[];
}

export interface TrayOptions {
	icon: string;
	tooltip?: string;
	title?: string;
	menu?: TrayMenuItem[];
}

export interface ShortcutOptions {
	id: string;
	accelerator: string;
	enabled?: boolean;
}

export interface NotificationOptions {
	title: string;
	body?: string;
	icon?: string;
	silent?: boolean;
	urgency?: "normal" | "critical" | "low";
}

export interface DesktopHttpRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | null;
	timeoutMs?: number;
}

export interface DesktopHttpRequestResult {
	status: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string | null;
}

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowOptions {
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	minWidth?: number;
	minHeight?: number;
	maxWidth?: number;
	maxHeight?: number;
	resizable?: boolean;
	alwaysOnTop?: boolean;
	fullscreen?: boolean;
	opacity?: number;
	title?: string;
}

export interface DesktopManagedWindowSnapshot {
	id: string;
	surface: string;
	title: string;
	singleton: boolean;
	alwaysOnTop: boolean;
}

export interface ClipboardWriteOptions {
	text?: string;
	html?: string;
	image?: string;
	rtf?: string;
}

export interface ClipboardReadResult {
	text?: string;
	html?: string;
	rtf?: string;
	hasImage: boolean;
}

export interface VersionInfo {
	version: string;
	name: string;
	runtime: string;
}

export interface DesktopBuildInfo {
	platform: string;
	arch: string;
	defaultRenderer: "native" | "cef";
	availableRenderers: Array<"native" | "cef">;
	cefVersion?: string;
	bunVersion?: string;
	runtime?: Record<string, unknown>;
}

export interface DesktopUpdaterSnapshot {
	currentVersion: string;
	currentHash?: string;
	channel?: string;
	baseUrl?: string;
	appBundlePath?: string | null;
	canAutoUpdate: boolean;
	autoUpdateDisabledReason?: string | null;
	updateAvailable: boolean;
	updateReady: boolean;
	latestVersion?: string | null;
	latestHash?: string | null;
	error?: string | null;
	lastStatus?: {
		status: string;
		message: string;
		timestamp: number;
	} | null;
}

export type DesktopSessionStorageType =
	| "cookies"
	| "localStorage"
	| "sessionStorage"
	| "indexedDB"
	| "webSQL"
	| "cache"
	| "all";

export interface DesktopSessionCookie {
	name: string;
	value?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	session?: boolean;
	expirationDate?: number;
}

export interface DesktopSessionSnapshot {
	partition: string;
	persistent: boolean;
	cookieCount: number;
	cookies: DesktopSessionCookie[];
}

export interface DesktopReleaseNotesWindowInfo {
	url: string;
	windowId: number | null;
	webviewId: number | null;
}

export interface PowerState {
	onBattery: boolean;
	idleState: "active" | "idle" | "locked" | "unknown";
	idleTime: number;
}

export interface TrayClickEvent {
	x: number;
	y: number;
	button: string;
	modifiers: { alt: boolean; shift: boolean; ctrl: boolean; meta: boolean };
}

// -- Gateway --
export interface GatewayEndpoint {
	stableId: string;
	name: string;
	host: string;
	port: number;
	lanHost?: string;
	tailnetDns?: string;
	gatewayPort?: number;
	canvasPort?: number;
	tlsEnabled: boolean;
	tlsFingerprintSha256?: string;
	isLocal: boolean;
}

export interface DiscoveryOptions {
	serviceType?: string;
	timeout?: number;
}

export interface DiscoveryResult {
	gateways: GatewayEndpoint[];
	status: string;
}

// -- Permissions --
export type {
	PermissionState,
	PermissionStatus,
	SystemPermissionId,
} from "@elizaos/shared";

import type { PermissionState, SystemPermissionId } from "@elizaos/shared";

/** Local variant uses an index signature (the canonical contract uses explicit keys). */
export interface AllPermissionsState {
	[key: string]: PermissionState;
}

// -- Canvas --
export interface CanvasWindowOptions {
	url?: string;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	title?: string;
	transparent?: boolean;
	alwaysOnTop?: boolean;
}

export interface CanvasWindowInfo {
	id: string;
	url: string;
	bounds: WindowBounds;
	title: string;
	alwaysOnTop: boolean;
}

// -- GPU Window / GPU View --
export interface GpuWindowInfo {
	id: string;
	frame: WindowBounds;
	/** Native numeric id of the embedded WGPUView (GpuWindow.wgpuViewId). */
	wgpuViewId?: number | null;
}

export interface GpuViewInfo {
	id: string;
	frame: WindowBounds;
	/** Native numeric id of the WGPUView (WGPUView.id). */
	viewId?: number | null;
}

// -- Steward Sidecar --
export interface StewardRpcStatus {
	state: "stopped" | "starting" | "running" | "error" | "restarting";
	port: number | null;
	pid: number | null;
	error: string | null;
	restartCount: number;
	walletAddress: string | null;
	agentId: string | null;
	tenantId: string | null;
	startedAt: number | null;
}

// -- Camera --
export interface CameraDevice {
	deviceId: string;
	label: string;
	kind: string;
}

// -- Credentials Auto-Detection --
export interface DetectedProvider {
	id: string;
	source: string;
	apiKey?: string;
	authMode?: string;
	cliInstalled: boolean;
	status: "valid" | "invalid" | "unchecked" | "error";
	statusDetail?: string;
}

// -- Screencapture --
export interface ScreenSource {
	id: string;
	name: string;
	thumbnail: string;
	appIcon?: string;
}

// -- Native Editor Bridge --
export type NativeEditorId =
	| "vscode"
	| "cursor"
	| "windsurf"
	| "antigravity"
	| "zed"
	| "sublime";

export interface NativeEditorInfo {
	id: NativeEditorId;
	label: string;
	installed: boolean;
	command: string;
}

export interface EditorSession {
	editorId: NativeEditorId;
	workspacePath: string;
	startedAt: number;
}

// -- Workspace File Watcher --
export type FileChangeEventType =
	| "created"
	| "modified"
	| "deleted"
	| "renamed";

export interface FileChangeEvent {
	watchId: string;
	type: FileChangeEventType;
	filePath: string;
	relativePath: string;
	timestamp: number;
}

export interface WatchStatus {
	watchId: string;
	watchPath: string;
	active: boolean;
	startedAt: number;
	eventCount: number;
}

// -- Floating Chat Window --
export interface FloatingChatStatus {
	open: boolean;
	visible: boolean;
	contextId: string | null;
	bounds: WindowBounds | null;
}

// -- TalkMode --
export type TalkModeState =
	| "idle"
	| "listening"
	| "processing"
	| "speaking"
	| "error";

export interface TalkModeConfig {
	engine?: "whisper" | "web";
	modelSize?: string;
	language?: string;
	voiceId?: string;
}

// -- Music player (plugin-music-player HTTP routes) --
/** Resolved HTTP URLs for plugin-music-player routes (agent process, not under /api). */
export interface MusicPlayerDesktopPlaybackUrls {
	ok: boolean;
	reason?: string;
	apiBase?: string;
	guildId?: string;
	streamUrl?: string;
	nowPlayingUrl?: string;
	queueUrl?: string;
}

// -- File Dialog --
export interface FileDialogOptions {
	title?: string;
	defaultPath?: string;
	/** Comma-separated file extensions, e.g. "png,jpg" or "*" for all */
	allowedFileTypes?: string;
	canChooseFiles?: boolean;
	canChooseDirectory?: boolean;
	allowsMultipleSelection?: boolean;
	buttonLabel?: string;
}

export interface FileDialogResult {
	canceled: boolean;
	filePaths: string[];
}

// -- Screen / Display --
export interface DisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DisplayInfo {
	id: number;
	bounds: DisplayBounds;
	workArea: DisplayBounds;
	scaleFactor: number;
	isPrimary: boolean;
}

export interface CursorPosition {
	x: number;
	y: number;
}

// -- Message Box (native alert/confirm/prompt) --
export interface MessageBoxOptions {
	type?: "info" | "warning" | "error" | "question";
	title?: string;
	message: string;
	detail?: string;
	buttons?: string[];
	defaultId?: number;
	cancelId?: number;
}

export interface MessageBoxResult {
	response: number;
}

export interface EmbeddedAgentStatus {
	state: "not_started" | "starting" | "running" | "stopped" | "error";
	agentName: string | null;
	port: number | null;
	startedAt: number | null;
	error: string | null;
}

export interface DesktopStartupDiagnostics {
	state: "not_started" | "starting" | "running" | "stopped" | "error";
	phase: string;
	updatedAt: string;
	lastError: string | null;
	agentName: string | null;
	port: number | null;
	startedAt: number | null;
	platform: string;
	arch: string;
	configDir: string;
	logPath: string;
	statusPath: string;
	logTail: string;
	appVersion?: string;
	appRuntime?: string;
	packaged?: boolean;
	locale?: string;
}

export interface DesktopBugReportBundleInfo {
	directory: string;
	reportMarkdownPath: string;
	reportJsonPath: string;
	startupLogPath: string | null;
	startupStatusPath: string | null;
}

// ============================================================================
// RPC Schema
// ============================================================================

export type ElizaDesktopRPCSchema = {
	bun: RPCSchema<{
		requests: {
			// ---- Agent ----
			agentStart: { params: undefined; response: EmbeddedAgentStatus };
			agentStop: { params: undefined; response: { ok: true } };
			agentRestart: { params: undefined; response: EmbeddedAgentStatus };
			agentRestartClearLocalDb: {
				params: undefined;
				response: EmbeddedAgentStatus;
			};
			agentStatus: { params: undefined; response: EmbeddedAgentStatus };
			agentInspectExistingInstall: {
				params: undefined;
				response: ExistingElizaInstallInfo;
			};
			agentPostReset: {
				params: { apiBase?: string; bearerToken?: string } | undefined | null;
				response: { ok: boolean; error?: string };
			};
			agentPostCloudDisconnect: {
				params: { apiBase?: string; bearerToken?: string } | undefined | null;
				response: { ok: boolean; error?: string };
			};
			/** Native confirm + main POST (renderer bridge/fetch can stall after a sheet). */
			agentCloudDisconnectWithConfirm: {
				params: { apiBase?: string; bearerToken?: string } | undefined | null;
				response:
					| { cancelled: true }
					| { ok: true }
					| { ok: false; error: string };
			};

			// ---- Desktop: Tray ----
			desktopCreateTray: { params: TrayOptions; response: undefined };
			desktopUpdateTray: { params: Partial<TrayOptions>; response: undefined };
			desktopDestroyTray: { params: undefined; response: undefined };
			desktopSetTrayMenu: {
				params: { menu: TrayMenuItem[] };
				response: undefined;
			};

			// ---- Desktop: Shortcuts ----
			desktopRegisterShortcut: {
				params: ShortcutOptions;
				response: { success: boolean };
			};
			desktopUnregisterShortcut: {
				params: { id: string };
				response: undefined;
			};
			desktopUnregisterAllShortcuts: { params: undefined; response: undefined };
			desktopIsShortcutRegistered: {
				params: { accelerator: string };
				response: { registered: boolean };
			};

			// ---- Desktop: Auto Launch ----
			desktopSetAutoLaunch: {
				params: { enabled: boolean; openAsHidden?: boolean };
				response: undefined;
			};
			desktopGetAutoLaunchStatus: {
				params: undefined;
				response: { enabled: boolean; openAsHidden: boolean };
			};

			// ---- Desktop: Window ----
			desktopSetWindowOptions: { params: WindowOptions; response: undefined };
			desktopGetWindowBounds: { params: undefined; response: WindowBounds };
			desktopSetWindowBounds: { params: WindowBounds; response: undefined };
			desktopMinimizeWindow: { params: undefined; response: undefined };
			desktopUnminimizeWindow: { params: undefined; response: undefined };
			desktopMaximizeWindow: { params: undefined; response: undefined };
			desktopUnmaximizeWindow: { params: undefined; response: undefined };
			desktopCloseWindow: { params: undefined; response: undefined };
			desktopShowWindow: { params: undefined; response: undefined };
			desktopHideWindow: { params: undefined; response: undefined };
			desktopFocusWindow: { params: undefined; response: undefined };
			desktopIsWindowMaximized: {
				params: undefined;
				response: { maximized: boolean };
			};
			desktopIsWindowMinimized: {
				params: undefined;
				response: { minimized: boolean };
			};
			desktopIsWindowVisible: {
				params: undefined;
				response: { visible: boolean };
			};
			desktopIsWindowFocused: {
				params: undefined;
				response: { focused: boolean };
			};
			desktopSetAlwaysOnTop: {
				params: { flag: boolean; level?: string };
				response: undefined;
			};
			desktopSetFullscreen: { params: { flag: boolean }; response: undefined };
			desktopSetOpacity: { params: { opacity: number }; response: undefined };

			// ---- Desktop: Notifications ----
			desktopShowNotification: {
				params: NotificationOptions;
				response: { id: string };
			};
			desktopCloseNotification: { params: { id: string }; response: undefined };
			desktopShowBackgroundNotice: {
				params: undefined;
				response: { shown: boolean };
			};

			// ---- Desktop: Power ----
			desktopGetPowerState: { params: undefined; response: PowerState };

			// ---- Screen ----
			desktopGetPrimaryDisplay: { params: undefined; response: DisplayInfo };
			desktopGetAllDisplays: {
				params: undefined;
				response: { displays: DisplayInfo[] };
			};
			desktopGetCursorPosition: { params: undefined; response: CursorPosition };

			// ---- Desktop: Message Box ----
			desktopShowMessageBox: {
				params: MessageBoxOptions;
				response: MessageBoxResult;
			};

			// ---- Desktop: App ----
			desktopQuit: { params: undefined; response: undefined };
			desktopRelaunch: { params: undefined; response: undefined };
			desktopApplyUpdate: { params: undefined; response: undefined };
			desktopCheckForUpdates: {
				params: undefined;
				response: DesktopUpdaterSnapshot;
			};
			desktopGetUpdaterState: {
				params: undefined;
				response: DesktopUpdaterSnapshot;
			};
			desktopGetVersion: { params: undefined; response: VersionInfo };
			desktopGetBuildInfo: { params: undefined; response: DesktopBuildInfo };
			desktopIsPackaged: { params: undefined; response: { packaged: boolean } };
			desktopGetDockIconVisibility: {
				params: undefined;
				response: { visible: boolean };
			};
			desktopSetDockIconVisibility: {
				params: { visible: boolean };
				response: { visible: boolean };
			};
			desktopGetPath: {
				params: { name: string };
				response: { path: string };
			};
			desktopGetStartupDiagnostics: {
				params: undefined;
				response: DesktopStartupDiagnostics;
			};
			desktopGetRuntimeMode: {
				params: undefined;
				response: {
					mode: "local" | "external" | "disabled";
					externalApiBase?: string | null;
					externalApiSource?: string | null;
				};
			};
			desktopHttpRequest: {
				params: DesktopHttpRequestOptions;
				response: DesktopHttpRequestResult;
			};
			desktopOpenLogsFolder: { params: undefined; response: undefined };
			desktopCreateBugReportBundle: {
				params: {
					reportMarkdown: string;
					reportJson: Record<string, unknown>;
					prefix?: string;
				};
				response: DesktopBugReportBundleInfo;
			};
			desktopBeep: { params: undefined; response: undefined };
			desktopShowSelectionContextMenu: {
				params: { text: string };
				response: { shown: boolean };
			};
			desktopGetSessionSnapshot: {
				params: { partition: string };
				response: DesktopSessionSnapshot;
			};
			desktopClearSessionData: {
				params: {
					partition: string;
					storageTypes?: DesktopSessionStorageType[] | "all";
					clearCookies?: boolean;
				};
				response: DesktopSessionSnapshot;
			};
			desktopGetWebGpuBrowserStatus: {
				params: undefined;
				response: {
					available: boolean;
					reason: string;
					renderer: string;
					chromeBetaPath: string | null;
					downloadUrl: string | null;
				};
			};
			desktopOpenReleaseNotesWindow: {
				params: { url: string; title?: string };
				response: DesktopReleaseNotesWindowInfo;
			};
			desktopOpenSettingsWindow: {
				params: { tabHint?: string } | undefined;
				response: undefined;
			};
			desktopOpenSurfaceWindow: {
				params: {
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
				};
				response: DesktopManagedWindowSnapshot | null;
			};
			desktopOpenAppWindow: {
				params: {
					slug?: string;
					title: string;
					path: string;
					alwaysOnTop?: boolean;
				};
				response: DesktopManagedWindowSnapshot | null;
			};
			desktopSetManagedWindowAlwaysOnTop: {
				params: { id: string; flag: boolean };
				response: { success: boolean };
			};

			// ---- Browser Workspace ----
			browserWorkspaceGetSnapshot: {
				params: undefined;
				response: BrowserWorkspaceSnapshot;
			};
			browserWorkspaceOpenTab: {
				params: OpenBrowserWorkspaceTabRequest;
				response: { tab: BrowserWorkspaceTab };
			};
			browserWorkspaceNavigateTab: {
				params: NavigateBrowserWorkspaceTabRequest;
				response: { tab: BrowserWorkspaceTab };
			};
			browserWorkspaceShowTab: {
				params: { id: string };
				response: { tab: BrowserWorkspaceTab };
			};
			browserWorkspaceHideTab: {
				params: { id: string };
				response: { tab: BrowserWorkspaceTab };
			};
			browserWorkspaceCloseTab: {
				params: { id: string };
				response: { closed: boolean };
			};
			browserWorkspaceSnapshotTab: {
				params: { id: string };
				response: { data: string };
			};

			// ---- Desktop: Clipboard ----
			desktopWriteToClipboard: {
				params: ClipboardWriteOptions;
				response: undefined;
			};
			desktopReadFromClipboard: {
				params: undefined;
				response: ClipboardReadResult;
			};
			desktopClearClipboard: { params: undefined; response: undefined };
			desktopClipboardAvailableFormats: {
				params: undefined;
				response: { formats: string[] };
			};

			// ---- Desktop: Shell ----
			desktopOpenExternal: { params: { url: string }; response: undefined };
			desktopShowItemInFolder: {
				params: { path: string };
				response: undefined;
			};
			desktopOpenPath: { params: { path: string }; response: undefined };

			// ---- Desktop: File Dialogs ----
			desktopShowOpenDialog: {
				params: FileDialogOptions;
				response: FileDialogResult;
			};
			desktopShowSaveDialog: {
				params: FileDialogOptions;
				response: FileDialogResult;
			};

			// ---- Gateway ----
			gatewayStartDiscovery: {
				params: DiscoveryOptions | undefined;
				response: DiscoveryResult;
			};
			gatewayStopDiscovery: { params: undefined; response: undefined };
			gatewayIsDiscovering: {
				params: undefined;
				response: { isDiscovering: boolean };
			};
			gatewayGetDiscoveredGateways: {
				params: undefined;
				response: { gateways: GatewayEndpoint[] };
			};

			// ---- Permissions ----
			permissionsCheck: {
				params: { id: SystemPermissionId; forceRefresh?: boolean };
				response: PermissionState;
			};
			permissionsCheckFeature: {
				params: { featureId: string };
				response: { granted: boolean; missing: SystemPermissionId[] };
			};
			permissionsRequest: {
				params: { id: SystemPermissionId };
				response: PermissionState;
			};
			permissionsGetAll: {
				params: { forceRefresh?: boolean };
				response: AllPermissionsState;
			};
			permissionsGetPlatform: { params: undefined; response: string };
			permissionsIsShellEnabled: { params: undefined; response: boolean };
			permissionsSetShellEnabled: {
				params: { enabled: boolean };
				response: PermissionState;
			};
			permissionsClearCache: { params: undefined; response: undefined };
			permissionsOpenSettings: {
				params: { id: SystemPermissionId };
				response: undefined;
			};

			// ---- Location ----
			locationGetCurrentPosition: {
				params: undefined;
				response: {
					latitude: number;
					longitude: number;
					accuracy: number;
					timestamp: number;
				} | null;
			};
			locationWatchPosition: {
				params: { interval?: number };
				response: { watchId: string };
			};
			locationClearWatch: { params: { watchId: string }; response: undefined };
			locationGetLastKnownLocation: {
				params: undefined;
				response: {
					latitude: number;
					longitude: number;
					accuracy: number;
					timestamp: number;
				} | null;
			};

			// ---- Camera (graceful stubs) ----
			cameraGetDevices: {
				params: undefined;
				response: { devices: CameraDevice[]; available: boolean };
			};
			cameraStartPreview: {
				params: { deviceId?: string };
				response: { available: boolean; reason?: string };
			};
			cameraStopPreview: { params: undefined; response: undefined };
			cameraSwitchCamera: {
				params: { deviceId: string };
				response: { available: boolean };
			};
			cameraCapturePhoto: {
				params: undefined;
				response: { available: boolean; data?: string };
			};
			cameraStartRecording: {
				params: undefined;
				response: { available: boolean };
			};
			cameraStopRecording: {
				params: undefined;
				response: { available: boolean; path?: string };
			};
			cameraGetRecordingState: {
				params: undefined;
				response: { recording: boolean; duration: number };
			};
			cameraCheckPermissions: {
				params: undefined;
				response: { status: string };
			};
			cameraRequestPermissions: {
				params: undefined;
				response: { status: string };
			};

			// ---- Canvas ----
			canvasCreateWindow: {
				params: CanvasWindowOptions;
				response: { id: string };
			};
			canvasDestroyWindow: { params: { id: string }; response: undefined };
			canvasNavigate: {
				params: { id: string; url: string };
				response: undefined;
			};
			/**
			 * PRIVILEGED: Executes arbitrary JavaScript in a canvas BrowserWindow.
			 * This is intentionally unrestricted for agent computer-use capabilities.
			 * Security relies on canvas windows being isolated from user-facing content.
			 * Any XSS in the main webview could invoke this on canvas windows.
			 */
			canvasEval: {
				params: { id: string; script: string };
				response: unknown;
			};
			canvasSnapshot: {
				params: { id: string; format?: string; quality?: number };
				response: { data: string } | null;
			};
			canvasA2uiPush: {
				params: { id: string; payload: unknown };
				response: undefined;
			};
			canvasA2uiReset: { params: { id: string }; response: undefined };
			canvasShow: { params: { id: string }; response: undefined };
			canvasHide: { params: { id: string }; response: undefined };
			canvasResize: {
				params: { id: string; width: number; height: number };
				response: undefined;
			};
			canvasFocus: { params: { id: string }; response: undefined };
			canvasGetBounds: {
				params: { id: string };
				response: WindowBounds;
			};
			canvasSetBounds: {
				params: { id: string } & WindowBounds;
				response: undefined;
			};
			canvasSetAlwaysOnTop: {
				params: { id: string; flag: boolean };
				response: { success: boolean };
			};
			canvasListWindows: {
				params: undefined;
				response: { windows: CanvasWindowInfo[] };
			};

			// ---- Game ----
			/** Opens a game client URL in a dedicated isolated BrowserWindow. */
			gameOpenWindow: {
				params: { url: string; title?: string; alwaysOnTop?: boolean };
				response: { id: string };
			};

			// ---- Screencapture (graceful stubs) ----
			screencaptureGetSources: {
				params: undefined;
				response: { sources: ScreenSource[]; available: boolean };
			};
			screencaptureTakeScreenshot: {
				params: undefined;
				response: { available: boolean; data?: string };
			};
			screencaptureCaptureWindow: {
				params: { windowId?: string };
				response: { available: boolean; data?: string };
			};
			screencaptureStartRecording: {
				params: undefined;
				response: { available: boolean; reason?: string };
			};
			screencaptureStopRecording: {
				params: undefined;
				response: { available: boolean; path?: string };
			};
			screencapturePauseRecording: {
				params: undefined;
				response: { available: boolean };
			};
			screencaptureResumeRecording: {
				params: undefined;
				response: { available: boolean };
			};
			screencaptureGetRecordingState: {
				params: undefined;
				response: { recording: boolean; duration: number; paused: boolean };
			};
			screencaptureStartFrameCapture: {
				params: {
					fps?: number;
					quality?: number;
					apiBase?: string;
					endpoint?: string;
					gameUrl?: string;
				};
				response: { available: boolean; reason?: string };
			};
			screencaptureStopFrameCapture: {
				params: undefined;
				response: { available: boolean };
			};
			screencaptureIsFrameCaptureActive: {
				params: undefined;
				response: { active: boolean };
			};
			screencaptureSaveScreenshot: {
				params: { data: string; filename?: string };
				response: { available: boolean; path?: string };
			};
			screencaptureSwitchSource: {
				params: { sourceId: string };
				response: { available: boolean };
			};
			screencaptureSetCaptureTarget: {
				params: { webviewId?: string };
				response: { available: boolean };
			};

			// ---- Swabble (wake word) ----
			swabbleStart: {
				params: {
					config?: {
						triggers?: string[];
						minPostTriggerGap?: number;
						minCommandLength?: number;
						modelSize?: "tiny" | "base" | "small" | "medium" | "large";
						enabled?: boolean;
					};
				};
				response: { started: boolean; error?: string };
			};
			swabbleStop: { params: undefined; response: undefined };
			swabbleIsListening: {
				params: undefined;
				response: { listening: boolean };
			};
			swabbleGetConfig: {
				params: undefined;
				response: Record<string, unknown>;
			};
			swabbleUpdateConfig: {
				params: Record<string, unknown>;
				response: undefined;
			};
			swabbleIsWhisperAvailable: {
				params: undefined;
				response: { available: boolean };
			};
			swabbleAudioChunk: { params: { data: string }; response: undefined };

			// ---- TalkMode ----
			talkmodeStart: {
				params: undefined;
				response: { available: boolean; reason?: string };
			};
			talkmodeStop: { params: undefined; response: undefined };
			talkmodeSpeak: {
				params: { text: string; directive?: Record<string, unknown> };
				response: undefined;
			};
			talkmodeStopSpeaking: { params: undefined; response: undefined };
			talkmodeGetState: {
				params: undefined;
				response: { state: TalkModeState };
			};
			talkmodeIsEnabled: { params: undefined; response: { enabled: boolean } };
			talkmodeIsSpeaking: {
				params: undefined;
				response: { speaking: boolean };
			};
			talkmodeGetWhisperInfo: {
				params: undefined;
				response: { available: boolean; modelSize?: string };
			};
			talkmodeIsWhisperAvailable: {
				params: undefined;
				response: { available: boolean };
			};
			talkmodeUpdateConfig: { params: TalkModeConfig; response: undefined };
			talkmodeAudioChunk: { params: { data: string }; response: undefined };

			// ---- Music player (elizaOS plugin-music-player HTTP routes on agent) ----
			musicPlayerGetDesktopPlaybackUrls: {
				params: { guildId?: string };
				response: MusicPlayerDesktopPlaybackUrls;
			};

			// ---- Context Menu ----
			contextMenuAskAgent: {
				params: { text: string };
				response: undefined;
			};
			contextMenuCreateSkill: {
				params: { text: string };
				response: undefined;
			};
			contextMenuQuoteInChat: {
				params: { text: string };
				response: undefined;
			};
			contextMenuSaveAsCommand: {
				params: { text: string };
				response: undefined;
			};

			// ---- Credentials Auto-Detection ----
			credentialsScanProviders: {
				params: { context: "onboarding" | "tray-refresh" };
				response: { providers: DetectedProvider[] };
			};
			credentialsScanAndValidate: {
				params: { context: "onboarding" | "tray-refresh" };
				response: { providers: DetectedProvider[] };
			};

			// ---- GPU Window ----
			gpuWindowCreate: {
				params: {
					id?: string;
					title?: string;
					x?: number;
					y?: number;
					width?: number;
					height?: number;
					transparent?: boolean;
					alwaysOnTop?: boolean;
					titleBarStyle?: "hidden" | "hiddenInset" | "default";
				};
				response: GpuWindowInfo;
			};
			gpuWindowDestroy: { params: { id: string }; response: undefined };
			gpuWindowShow: { params: { id: string }; response: undefined };
			gpuWindowHide: { params: { id: string }; response: undefined };
			gpuWindowSetBounds: {
				params: { id: string } & WindowBounds;
				response: undefined;
			};
			gpuWindowGetInfo: {
				params: { id: string };
				response: GpuWindowInfo | null;
			};
			gpuWindowList: {
				params: undefined;
				response: { windows: GpuWindowInfo[] };
			};

			// ---- GPU View ----
			gpuViewCreate: {
				params: {
					id?: string;
					windowId: number;
					x?: number;
					y?: number;
					width?: number;
					height?: number;
					autoResize?: boolean;
					transparent?: boolean;
					passthrough?: boolean;
				};
				response: GpuViewInfo;
			};
			gpuViewDestroy: { params: { id: string }; response: undefined };
			gpuViewSetFrame: {
				params: { id: string } & WindowBounds;
				response: undefined;
			};
			gpuViewSetTransparent: {
				params: { id: string; transparent: boolean };
				response: undefined;
			};
			gpuViewSetHidden: {
				params: { id: string; hidden: boolean };
				response: undefined;
			};
			gpuViewGetNativeHandle: {
				params: { id: string };
				response: { handle: unknown } | null;
			};
			gpuViewList: {
				params: undefined;
				response: { views: GpuViewInfo[] };
			};

			// ---- Native Editor Bridge ----
			editorBridgeListEditors: {
				params: undefined;
				response: { editors: NativeEditorInfo[] };
			};
			editorBridgeOpenInEditor: {
				params: { editorId: NativeEditorId; workspacePath: string };
				response: EditorSession;
			};
			editorBridgeGetSession: {
				params: undefined;
				response: EditorSession | null;
			};
			editorBridgeClearSession: {
				params: undefined;
				response: undefined;
			};

			// ---- Workspace File Watcher ----
			fileWatcherStart: {
				params: { watchPath: string };
				response: { watchId: string };
			};
			fileWatcherStop: {
				params: { watchId: string };
				response: { stopped: boolean };
			};
			fileWatcherStopAll: {
				params: undefined;
				response: undefined;
			};
			fileWatcherList: {
				params: undefined;
				response: { watches: WatchStatus[] };
			};
			fileWatcherGetStatus: {
				params: { watchId: string };
				response: WatchStatus | null;
			};

			// ---- Floating Chat Window ----
			floatingChatOpen: {
				params: { contextId?: string; x?: number; y?: number };
				response: FloatingChatStatus;
			};
			floatingChatShow: {
				params: undefined;
				response: FloatingChatStatus;
			};
			floatingChatHide: {
				params: undefined;
				response: FloatingChatStatus;
			};
			floatingChatClose: {
				params: undefined;
				response: FloatingChatStatus;
			};
			floatingChatSetContext: {
				params: { contextId: string | null };
				response: FloatingChatStatus;
			};
			floatingChatGetStatus: {
				params: undefined;
				response: FloatingChatStatus;
			};

			// ---- Steward Sidecar ----
			stewardGetStatus: {
				params: undefined;
				response: StewardRpcStatus;
			};
			stewardIsLocalEnabled: {
				params: undefined;
				response: { enabled: boolean };
			};
			stewardStart: {
				params: undefined;
				response: StewardRpcStatus;
			};
			stewardRestart: {
				params: undefined;
				response: StewardRpcStatus;
			};
			stewardReset: {
				params: undefined;
				response: StewardRpcStatus;
			};
		};
		// biome-ignore lint/complexity/noBannedTypes: empty message schema placeholder for future audio streaming
		messages: {
			// Messages the webview sends TO bun (rare - most communication
			// is request/response). Audio chunks for streaming could go here.
		};
	}>;
	webview: RPCSchema<{
		requests: {
			// Built-in: evaluateJavascriptWithResponse is added by Electroview.

			// Browser Workspace — bun delegates evaluate/get-tab-rect to the
			// renderer, which holds the <electrobun-webview> tag refs and runs the
			// request against the matching tab. The rect is in CSS pixels relative
			// to the renderer viewport; bun adds the main-window origin and runs
			// the OS screencapture itself.
			browserWorkspaceRendererEvaluate: {
				params: { id: string; script: string; timeoutMs: number };
				response: { ok: boolean; result?: unknown; error?: string };
			};
			browserWorkspaceRendererGetTabRect: {
				params: { id: string };
				response: {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
			};
		};
		messages: {
			// Push events FROM bun TO webview

			// Gateway
			gatewayDiscovery: {
				type: "found" | "updated" | "lost";
				gateway: GatewayEndpoint;
			};

			// Permissions
			permissionsChanged: { id: string };

			// Desktop: Tray events
			desktopTrayMenuClick: {
				itemId: string;
				checked?: boolean;
				/** Present when `itemId === "menu-reset-applied"` (main-process reset). */
				agentStatus?: Record<string, unknown> | null;
			};
			desktopTrayClick: TrayClickEvent;

			// Desktop: Shortcut events
			desktopShortcutPressed: { id: string; accelerator: string };

			// Desktop: Window events
			desktopWindowFocus: undefined;
			desktopWindowBlur: undefined;
			desktopWindowMaximize: undefined;
			desktopWindowUnmaximize: undefined;
			desktopWindowClose: undefined;
			desktopShutdownStarted: { reason: string };
			desktopManagedWindowsChanged: {
				windows: DesktopManagedWindowSnapshot[];
			};

			// Canvas: Window events
			canvasWindowEvent: {
				windowId: string;
				event: string;
				data?: unknown;
			};

			// TalkMode: Audio/state push events
			talkmodeAudioChunkPush: { data: string };
			talkmodeStateChanged: { state: TalkModeState };
			talkmodeSpeakComplete: undefined;
			talkmodeTranscript: {
				text: string;
				segments: Array<{ text: string; start: number; end: number }>;
			};
			talkmodeError: {
				code: string;
				message: string;
				recoverable: boolean;
			};

			// Swabble: Wake word detection
			swabbleWakeWord: {
				trigger: string;
				command: string;
				transcript: string;
			};
			swabbleStateChanged: { listening: boolean };
			swabbleTranscript: {
				transcript: string;
				segments: Array<{
					text: string;
					start: number;
					duration: number;
					isFinal: boolean;
				}>;
				isFinal: boolean;
				confidence?: number;
			};
			swabbleError: {
				code: string;
				message: string;
				recoverable: boolean;
			};
			// Swabble: audio chunk fallback (whisper.cpp binary missing)
			swabbleAudioChunkPush: { data: string };

			// Context menu push events (Bun pushes to renderer after processing)
			contextMenuAskAgent: { text: string };
			contextMenuCreateSkill: { text: string };
			contextMenuQuoteInChat: { text: string };
			contextMenuSaveAsCommand: { text: string };

			// Workspace file change push events
			workspaceFileChanged: FileChangeEvent;

			// Editor bridge push events
			editorSessionChanged: EditorSession | null;

			// Floating chat push events
			floatingChatStatusChanged: FloatingChatStatus;

			// API Base injection
			apiBaseUpdate: { base: string; token?: string };

			// Share target
			shareTargetReceived: { url: string; text?: string };

			// Location push events
			locationUpdate: {
				latitude: number;
				longitude: number;
				accuracy: number;
				timestamp: number;
			};

			// Desktop: Update events
			desktopUpdateAvailable: { version: string; releaseNotes?: string };
			desktopUpdateReady: { version: string };

			// GPU Window push events
			gpuWindowClosed: { id: string };

			// Steward sidecar status push
			stewardStatusUpdate: StewardRpcStatus;

			// WebGPU browser support status
			webGpuBrowserStatus: {
				available: boolean;
				reason: string;
				renderer: string;
				chromeBetaPath: string | null;
				downloadUrl: string | null;
			};
		};
	}>;
};

// ============================================================================
// Channel ↔ RPC Method Mapping
// ============================================================================

/**
 * Maps legacy colon-separated desktop channel names to camelCase RPC
 * method names. Used by the renderer bridge for backward compatibility.
 */
export const CHANNEL_TO_RPC_METHOD: Record<string, string> = {
	// Agent
	"agent:start": "agentStart",
	"agent:stop": "agentStop",
	"agent:restart": "agentRestart",
	"agent:restartClearLocalDb": "agentRestartClearLocalDb",
	"agent:status": "agentStatus",
	"agent:inspectExistingInstall": "agentInspectExistingInstall",
	"agent:postReset": "agentPostReset",
	"agent:postCloudDisconnect": "agentPostCloudDisconnect",
	"agent:cloudDisconnectWithConfirm": "agentCloudDisconnectWithConfirm",

	// Desktop: Tray
	"desktop:createTray": "desktopCreateTray",
	"desktop:updateTray": "desktopUpdateTray",
	"desktop:destroyTray": "desktopDestroyTray",
	"desktop:setTrayMenu": "desktopSetTrayMenu",

	// Desktop: Shortcuts
	"desktop:registerShortcut": "desktopRegisterShortcut",
	"desktop:unregisterShortcut": "desktopUnregisterShortcut",
	"desktop:unregisterAllShortcuts": "desktopUnregisterAllShortcuts",
	"desktop:isShortcutRegistered": "desktopIsShortcutRegistered",

	// Desktop: Auto Launch
	"desktop:setAutoLaunch": "desktopSetAutoLaunch",
	"desktop:getAutoLaunchStatus": "desktopGetAutoLaunchStatus",

	// Desktop: Window
	"desktop:setWindowOptions": "desktopSetWindowOptions",
	"desktop:getWindowBounds": "desktopGetWindowBounds",
	"desktop:setWindowBounds": "desktopSetWindowBounds",
	"desktop:minimizeWindow": "desktopMinimizeWindow",
	"desktop:unminimizeWindow": "desktopUnminimizeWindow",
	"desktop:maximizeWindow": "desktopMaximizeWindow",
	"desktop:unmaximizeWindow": "desktopUnmaximizeWindow",
	"desktop:closeWindow": "desktopCloseWindow",
	"desktop:showWindow": "desktopShowWindow",
	"desktop:hideWindow": "desktopHideWindow",
	"desktop:focusWindow": "desktopFocusWindow",
	"desktop:isWindowMaximized": "desktopIsWindowMaximized",
	"desktop:isWindowMinimized": "desktopIsWindowMinimized",
	"desktop:isWindowVisible": "desktopIsWindowVisible",
	"desktop:isWindowFocused": "desktopIsWindowFocused",
	"desktop:setAlwaysOnTop": "desktopSetAlwaysOnTop",
	"desktop:setFullscreen": "desktopSetFullscreen",
	"desktop:setOpacity": "desktopSetOpacity",

	// Desktop: Notifications
	"desktop:showNotification": "desktopShowNotification",
	"desktop:closeNotification": "desktopCloseNotification",
	"desktop:showBackgroundNotice": "desktopShowBackgroundNotice",

	// Desktop: Power
	"desktop:getPowerState": "desktopGetPowerState",

	// Desktop: Screen
	"desktop:getPrimaryDisplay": "desktopGetPrimaryDisplay",
	"desktop:getAllDisplays": "desktopGetAllDisplays",
	"desktop:getCursorPosition": "desktopGetCursorPosition",

	// Desktop: Message Box
	"desktop:showMessageBox": "desktopShowMessageBox",

	// Desktop: App
	"desktop:quit": "desktopQuit",
	"desktop:relaunch": "desktopRelaunch",
	"desktop:applyUpdate": "desktopApplyUpdate",
	"desktop:checkForUpdates": "desktopCheckForUpdates",
	"desktop:getUpdaterState": "desktopGetUpdaterState",
	"desktop:getVersion": "desktopGetVersion",
	"desktop:getBuildInfo": "desktopGetBuildInfo",
	"desktop:isPackaged": "desktopIsPackaged",
	"desktop:getDockIconVisibility": "desktopGetDockIconVisibility",
	"desktop:setDockIconVisibility": "desktopSetDockIconVisibility",
	"desktop:getPath": "desktopGetPath",
	"desktop:getStartupDiagnostics": "desktopGetStartupDiagnostics",
	"desktop:getRuntimeMode": "desktopGetRuntimeMode",
	"desktop:openLogsFolder": "desktopOpenLogsFolder",
	"desktop:createBugReportBundle": "desktopCreateBugReportBundle",
	"desktop:beep": "desktopBeep",
	"desktop:showSelectionContextMenu": "desktopShowSelectionContextMenu",
	"desktop:getSessionSnapshot": "desktopGetSessionSnapshot",
	"desktop:clearSessionData": "desktopClearSessionData",
	"desktop:getWebGpuBrowserStatus": "desktopGetWebGpuBrowserStatus",
	"desktop:openReleaseNotesWindow": "desktopOpenReleaseNotesWindow",
	"desktop:openSettingsWindow": "desktopOpenSettingsWindow",
	"desktop:openSurfaceWindow": "desktopOpenSurfaceWindow",
	"desktop:openAppWindow": "desktopOpenAppWindow",
	"desktop:setManagedWindowAlwaysOnTop": "desktopSetManagedWindowAlwaysOnTop",

	// Browser Workspace
	"browser-workspace:getSnapshot": "browserWorkspaceGetSnapshot",
	"browser-workspace:openTab": "browserWorkspaceOpenTab",
	"browser-workspace:navigateTab": "browserWorkspaceNavigateTab",
	"browser-workspace:showTab": "browserWorkspaceShowTab",
	"browser-workspace:hideTab": "browserWorkspaceHideTab",
	"browser-workspace:closeTab": "browserWorkspaceCloseTab",
	"browser-workspace:snapshotTab": "browserWorkspaceSnapshotTab",

	// Desktop: Clipboard
	"desktop:writeToClipboard": "desktopWriteToClipboard",
	"desktop:readFromClipboard": "desktopReadFromClipboard",
	"desktop:clearClipboard": "desktopClearClipboard",
	"desktop:clipboardAvailableFormats": "desktopClipboardAvailableFormats",

	// Desktop: Shell
	"desktop:openExternal": "desktopOpenExternal",
	"desktop:showItemInFolder": "desktopShowItemInFolder",
	"desktop:openPath": "desktopOpenPath",

	// Desktop: File Dialogs
	"desktop:showOpenDialog": "desktopShowOpenDialog",
	"desktop:showSaveDialog": "desktopShowSaveDialog",

	// Gateway
	"gateway:startDiscovery": "gatewayStartDiscovery",
	"gateway:stopDiscovery": "gatewayStopDiscovery",
	"gateway:isDiscovering": "gatewayIsDiscovering",
	"gateway:getDiscoveredGateways": "gatewayGetDiscoveredGateways",

	// Permissions
	"permissions:check": "permissionsCheck",
	"permissions:checkFeature": "permissionsCheckFeature",
	"permissions:request": "permissionsRequest",
	"permissions:getAll": "permissionsGetAll",
	"permissions:getPlatform": "permissionsGetPlatform",
	"permissions:isShellEnabled": "permissionsIsShellEnabled",
	"permissions:setShellEnabled": "permissionsSetShellEnabled",
	"permissions:clearCache": "permissionsClearCache",
	"permissions:openSettings": "permissionsOpenSettings",

	// Location
	"location:getCurrentPosition": "locationGetCurrentPosition",
	"location:watchPosition": "locationWatchPosition",
	"location:clearWatch": "locationClearWatch",
	"location:getLastKnownLocation": "locationGetLastKnownLocation",

	// Camera
	"camera:getDevices": "cameraGetDevices",
	"camera:startPreview": "cameraStartPreview",
	"camera:stopPreview": "cameraStopPreview",
	"camera:switchCamera": "cameraSwitchCamera",
	"camera:capturePhoto": "cameraCapturePhoto",
	"camera:startRecording": "cameraStartRecording",
	"camera:stopRecording": "cameraStopRecording",
	"camera:getRecordingState": "cameraGetRecordingState",
	"camera:checkPermissions": "cameraCheckPermissions",
	"camera:requestPermissions": "cameraRequestPermissions",

	// Canvas
	"canvas:createWindow": "canvasCreateWindow",
	"canvas:destroyWindow": "canvasDestroyWindow",
	"canvas:navigate": "canvasNavigate",
	"canvas:eval": "canvasEval",
	"canvas:snapshot": "canvasSnapshot",
	"canvas:a2uiPush": "canvasA2uiPush",
	"canvas:a2uiReset": "canvasA2uiReset",
	"canvas:show": "canvasShow",
	"canvas:hide": "canvasHide",
	"canvas:resize": "canvasResize",
	"canvas:focus": "canvasFocus",
	"canvas:getBounds": "canvasGetBounds",
	"canvas:setBounds": "canvasSetBounds",
	"canvas:setAlwaysOnTop": "canvasSetAlwaysOnTop",
	"canvas:listWindows": "canvasListWindows",

	// Game
	"game:openWindow": "gameOpenWindow",

	// Screencapture
	"screencapture:getSources": "screencaptureGetSources",
	"screencapture:takeScreenshot": "screencaptureTakeScreenshot",
	"screencapture:captureWindow": "screencaptureCaptureWindow",
	"screencapture:startRecording": "screencaptureStartRecording",
	"screencapture:stopRecording": "screencaptureStopRecording",
	"screencapture:pauseRecording": "screencapturePauseRecording",
	"screencapture:resumeRecording": "screencaptureResumeRecording",
	"screencapture:getRecordingState": "screencaptureGetRecordingState",
	"screencapture:startFrameCapture": "screencaptureStartFrameCapture",
	"screencapture:stopFrameCapture": "screencaptureStopFrameCapture",
	"screencapture:isFrameCaptureActive": "screencaptureIsFrameCaptureActive",
	"screencapture:saveScreenshot": "screencaptureSaveScreenshot",
	"screencapture:switchSource": "screencaptureSwitchSource",
	"screencapture:setCaptureTarget": "screencaptureSetCaptureTarget",

	// Swabble
	"swabble:start": "swabbleStart",
	"swabble:stop": "swabbleStop",
	"swabble:isListening": "swabbleIsListening",
	"swabble:getConfig": "swabbleGetConfig",
	"swabble:updateConfig": "swabbleUpdateConfig",
	"swabble:isWhisperAvailable": "swabbleIsWhisperAvailable",
	"swabble:audioChunk": "swabbleAudioChunk",

	// TalkMode
	"talkmode:start": "talkmodeStart",
	"talkmode:stop": "talkmodeStop",
	"talkmode:speak": "talkmodeSpeak",
	"talkmode:stopSpeaking": "talkmodeStopSpeaking",
	"talkmode:getState": "talkmodeGetState",
	"talkmode:isEnabled": "talkmodeIsEnabled",
	"talkmode:isSpeaking": "talkmodeIsSpeaking",
	"talkmode:getWhisperInfo": "talkmodeGetWhisperInfo",
	"talkmode:isWhisperAvailable": "talkmodeIsWhisperAvailable",
	"talkmode:updateConfig": "talkmodeUpdateConfig",
	"talkmode:audioChunk": "talkmodeAudioChunk",

	// Music player (desktop)
	"musicPlayer:getDesktopPlaybackUrls": "musicPlayerGetDesktopPlaybackUrls",

	// Context Menu
	"contextMenu:askAgent": "contextMenuAskAgent",
	"contextMenu:createSkill": "contextMenuCreateSkill",
	"contextMenu:quoteInChat": "contextMenuQuoteInChat",
	"contextMenu:saveAsCommand": "contextMenuSaveAsCommand",

	// Credentials
	"credentials:scanProviders": "credentialsScanProviders",
	"credentials:scanAndValidate": "credentialsScanAndValidate",

	// GPU Window
	"gpuWindow:create": "gpuWindowCreate",
	"gpuWindow:destroy": "gpuWindowDestroy",
	"gpuWindow:show": "gpuWindowShow",
	"gpuWindow:hide": "gpuWindowHide",
	"gpuWindow:setBounds": "gpuWindowSetBounds",
	"gpuWindow:getInfo": "gpuWindowGetInfo",
	"gpuWindow:list": "gpuWindowList",

	// GPU View
	"gpuView:create": "gpuViewCreate",
	"gpuView:destroy": "gpuViewDestroy",
	"gpuView:setFrame": "gpuViewSetFrame",
	"gpuView:setTransparent": "gpuViewSetTransparent",
	"gpuView:setHidden": "gpuViewSetHidden",
	"gpuView:getNativeHandle": "gpuViewGetNativeHandle",
	"gpuView:list": "gpuViewList",

	// Steward Sidecar
	"steward:getStatus": "stewardGetStatus",
	"steward:isLocalEnabled": "stewardIsLocalEnabled",
	"steward:start": "stewardStart",
	"steward:restart": "stewardRestart",
	"steward:reset": "stewardReset",

	// Native Editor Bridge
	"editorBridge:listEditors": "editorBridgeListEditors",
	"editorBridge:openInEditor": "editorBridgeOpenInEditor",
	"editorBridge:getSession": "editorBridgeGetSession",
	"editorBridge:clearSession": "editorBridgeClearSession",

	// Workspace File Watcher
	"fileWatcher:start": "fileWatcherStart",
	"fileWatcher:stop": "fileWatcherStop",
	"fileWatcher:stopAll": "fileWatcherStopAll",
	"fileWatcher:list": "fileWatcherList",
	"fileWatcher:getStatus": "fileWatcherGetStatus",

	// Floating Chat Window
	"floatingChat:open": "floatingChatOpen",
	"floatingChat:show": "floatingChatShow",
	"floatingChat:hide": "floatingChatHide",
	"floatingChat:close": "floatingChatClose",
	"floatingChat:setContext": "floatingChatSetContext",
	"floatingChat:getStatus": "floatingChatGetStatus",
};

/**
 * Maps legacy desktop push channel names to RPC message names.
 * Used by the renderer bridge to subscribe to push events.
 */
export const PUSH_CHANNEL_TO_RPC_MESSAGE: Record<string, string> = {
	"agent:status": "agentStatusUpdate",
	"gateway:discovery": "gatewayDiscovery",
	"permissions:changed": "permissionsChanged",
	"desktop:trayMenuClick": "desktopTrayMenuClick",
	"desktop:trayClick": "desktopTrayClick",
	"desktop:shortcutPressed": "desktopShortcutPressed",
	"desktop:windowFocus": "desktopWindowFocus",
	"desktop:windowBlur": "desktopWindowBlur",
	"desktop:windowMaximize": "desktopWindowMaximize",
	"desktop:windowUnmaximize": "desktopWindowUnmaximize",
	"desktop:windowClose": "desktopWindowClose",
	"desktop:shutdownStarted": "desktopShutdownStarted",
	"desktop:managedWindowsChanged": "desktopManagedWindowsChanged",
	"canvas:windowEvent": "canvasWindowEvent",
	"talkmode:audioChunkPush": "talkmodeAudioChunkPush",
	"talkmode:stateChanged": "talkmodeStateChanged",
	"talkmode:speakComplete": "talkmodeSpeakComplete",
	"talkmode:transcript": "talkmodeTranscript",
	"talkmode:error": "talkmodeError",
	"swabble:wakeWord": "swabbleWakeWord",
	"swabble:stateChange": "swabbleStateChanged",
	"swabble:transcript": "swabbleTranscript",
	"swabble:error": "swabbleError",
	"swabble:audioChunkPush": "swabbleAudioChunkPush",
	"contextMenu:askAgent": "contextMenuAskAgent",
	"contextMenu:createSkill": "contextMenuCreateSkill",
	"contextMenu:quoteInChat": "contextMenuQuoteInChat",
	"contextMenu:saveAsCommand": "contextMenuSaveAsCommand",
	apiBaseUpdate: "apiBaseUpdate",
	shareTargetReceived: "shareTargetReceived",
	"location:update": "locationUpdate",
	"desktop:updateAvailable": "desktopUpdateAvailable",
	"desktop:updateReady": "desktopUpdateReady",

	// GPU Window push events
	"gpuWindow:closed": "gpuWindowClosed",

	// Steward sidecar
	stewardStatusUpdate: "stewardStatusUpdate",

	// WebGPU browser support
	"webgpu:browserStatus": "webGpuBrowserStatus",

	// Workspace file watcher
	"fileWatcher:fileChanged": "workspaceFileChanged",

	// Editor bridge
	"editorBridge:sessionChanged": "editorSessionChanged",

	// Floating chat
	"floatingChat:statusChanged": "floatingChatStatusChanged",
};

/**
 * Reverse mapping: RPC message name → legacy desktop push channel name.
 */
export const RPC_MESSAGE_TO_PUSH_CHANNEL: Record<string, string> =
	Object.fromEntries(
		Object.entries(PUSH_CHANNEL_TO_RPC_MESSAGE).map(([k, v]) => [v, k]),
	);
