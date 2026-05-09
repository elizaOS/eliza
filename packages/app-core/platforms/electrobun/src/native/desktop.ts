/**
 * Desktop Native Module for Electrobun
 *
 * Implements the desktop manager on top of Electrobun APIs:
 * - System tray management (Tray)
 * - Global keyboard shortcuts (GlobalShortcut)
 * - Window management (BrowserWindow)
 * - Native notifications (Utils.showNotification)
 * - Clipboard operations (Utils.clipboard*)
 * - Shell operations (Utils.openExternal, Utils.showItemInFolder)
 * - App lifecycle (Utils.quit)
 * - Path resolution (Utils.paths)
 *
 * Key differences from the prior desktop runtime:
 * - No ipcMain — methods are called directly from rpc-handlers.ts
 * - Uses sendToWebview callback instead of mainWindow.webContents.send()
 * - No powerMonitor — power state via `pmset` (macOS), sysfs (Linux), or WinForms power line (Windows)
 * - No nativeImage — tray icons use file paths directly
 * - No setOpacity on BrowserWindow — no-op
 * - No hide() on BrowserWindow — uses minimize() as fallback
 * - No app.setLoginItemSettings — stubbed
 */

import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Electrobun, {
	type ApplicationMenuItemConfig,
	BrowserView,
	type BrowserWindow,
	BuildConfig,
	ContextMenu,
	GlobalShortcut,
	type MenuItemConfig,
	Screen,
	Session,
	Tray,
	Updater,
	Utils,
} from "electrobun/bun";
import { getBrandConfig } from "../brand-config";
import { logger } from "../logger";
import type {
	ClipboardReadResult,
	ClipboardWriteOptions,
	CursorPosition,
	DesktopBuildInfo,
	DesktopManagedWindowSnapshot,
	DesktopReleaseNotesWindowInfo,
	DesktopSessionSnapshot,
	DesktopSessionStorageType,
	DesktopUpdaterSnapshot,
	DisplayInfo,
	FileDialogOptions,
	FileDialogResult,
	MessageBoxOptions,
	MessageBoxResult,
	NotificationOptions,
	PowerState,
	ShortcutOptions,
	TrayMenuItem,
	TrayOptions,
	VersionInfo,
	WindowBounds,
	WindowOptions,
} from "../rpc-schema";
import type { SendToWebview } from "../types.js";
import {
	createBugReportBundle,
	getStartupDiagnosticLogTail,
	getStartupDiagnosticsSnapshot,
} from "./agent";
import {
	isAppActive,
	isKeyWindow,
	makeKeyAndOrderFront,
	orderOut,
} from "./mac-window-effects";
import {
	linuxSysfsOnBattery,
	parseLinuxLockedHintOutput,
	parseMacOsHidIdleTimeOutput,
	parseMacOsPowerSourceOutput,
	parseMacOsSessionLockedOutput,
	parseWindowsIdleTimeOutput,
	parseWindowsLockStateOutput,
	parseWindowsPowerLineOutput,
	parseXprintidleOutput,
} from "./power-state";
import { checkWebGpuSupport } from "./webgpu-browser-support";

interface SetAlwaysOnTopOptions {
	flag: boolean;
	level?: string;
}

interface SetFullscreenOptions {
	flag: boolean;
}

interface SetOpacityOptions {
	opacity: number;
}

interface OpenExternalOptions {
	url: string;
}

interface ShowItemInFolderOptions {
	path: string;
}

type ElectrobunEventHandler = (...args: unknown[]) => void;

interface ElectrobunEventTarget {
	off?: (event: string, handler: ElectrobunEventHandler) => void;
	removeListener?: (event: string, handler: ElectrobunEventHandler) => void;
}

// ============================================================================
// Path name mapping: legacy desktop path names -> Utils.paths equivalents
// ============================================================================

const PATH_NAME_MAP: Record<string, string | (() => string)> = {
	home: Utils.paths.home,
	appData: Utils.paths.appData,
	userData: Utils.paths.userData,
	userCache: Utils.paths.userCache,
	userLogs: Utils.paths.userLogs,
	temp: Utils.paths.temp,
	cache: Utils.paths.cache,
	logs: Utils.paths.logs,
	config: Utils.paths.config,
	documents: Utils.paths.documents,
	downloads: Utils.paths.downloads,
	desktop: Utils.paths.desktop,
	pictures: Utils.paths.pictures,
	music: Utils.paths.music,
	videos: Utils.paths.videos,
};

const DEFAULT_RELEASE_NOTES_URL = getBrandConfig().releaseUrl;
const RELEASE_NOTES_PARTITION = getBrandConfig().releaseNotesPartition;
const MACOS_IDLE_THRESHOLD_SECONDS = 60;
const MACOS_CGSESSION_PATH =
	"/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";
const LINUX_IDLE_THRESHOLD_SECONDS = 60;
const WINDOWS_IDLE_THRESHOLD_SECONDS = 60;
const POWER_STATE_PROBE_TIMEOUT_MS = 1_500;

let activeDesktopManager: DesktopManager | null = null;
let nativeContextMenuEventsInstalled = false;

export function resetDesktopManagerForTesting(): void {
	activeDesktopManager = null;
	nativeContextMenuEventsInstalled = false;
}

/**
 * Injectable shell-runner used by every native power-state probe in this
 * module. Tests override this via {@link setNativeShellRunnerForTesting} so
 * `pmset`, `ioreg`, `CGSession`, `xprintidle`, `loginctl`, `powershell`, and
 * other host subprocesses are never invoked on developer machines during
 * unit / integration runs.
 */
export interface NativeShellRunner {
	read(argv: string[]): Promise<string>;
	readSafe(argv: string[], timeoutMs?: number): Promise<string | null>;
}

const realNativeShellRunner: NativeShellRunner = {
	async read(argv) {
		const proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "ignore",
		});
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return text;
	},
	async readSafe(argv, timeoutMs = POWER_STATE_PROBE_TIMEOUT_MS) {
		try {
			const proc = Bun.spawn(argv, {
				stdout: "pipe",
				stderr: "ignore",
			});
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, timeoutMs);
			const text = await new Response(proc.stdout).text();
			await proc.exited;
			clearTimeout(timer);
			if (typeof proc.exitCode === "number" && proc.exitCode !== 0) {
				return null;
			}
			return text;
		} catch {
			return null;
		}
	},
};

let activeNativeShellRunner: NativeShellRunner = realNativeShellRunner;

/**
 * Test-only seam: swap the native shell runner used by power-state probes.
 * Pass `null` to restore the real `Bun.spawn`-backed implementation.
 */
export function setNativeShellRunnerForTesting(
	runner: NativeShellRunner | null,
): void {
	activeNativeShellRunner = runner ?? realNativeShellRunner;
}

function readProcessStdout(argv: string[]): Promise<string> {
	return activeNativeShellRunner.read(argv);
}

function readProcessStdoutSafe(
	argv: string[],
	timeoutMs = POWER_STATE_PROBE_TIMEOUT_MS,
): Promise<string | null> {
	return activeNativeShellRunner.readSafe(argv, timeoutMs);
}

async function readLinuxLockedHint(): Promise<boolean | null> {
	const sessionId = process.env.XDG_SESSION_ID?.trim();
	if (!sessionId) {
		return null;
	}
	const output = await readProcessStdoutSafe([
		"loginctl",
		"show-session",
		sessionId,
		"-p",
		"LockedHint",
	]);
	return output ? parseLinuxLockedHintOutput(output) : null;
}

const WINDOWS_IDLE_POWERSHELL_SCRIPT = [
	"Add-Type -Namespace W -Name U32 -MemberDefinition @'",
	'  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
	"  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO {",
	"    public uint cbSize; public uint dwTime;",
	"  }",
	"'@;",
	"$info = New-Object W.U32+LASTINPUTINFO;",
	"$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info);",
	"[void][W.U32]::GetLastInputInfo([ref]$info);",
	"[int]($env:COMPUTERNAME | Out-Null);",
	"[int][System.Environment]::TickCount - [int]$info.dwTime",
].join(" ");

// ============================================================================
// DesktopManager
// ============================================================================

/**
 * Desktop Manager — handles all native desktop features for Electrobun.
 *
 * This implementation does not register IPC handlers.
 * Methods are called directly from rpc-handlers.ts. Push events to the
 * webview are sent via the sendToWebview callback.
 */
export class DesktopManager {
	private mainWindow: BrowserWindow | null = null;
	private tray: Tray | null = null;
	private releaseNotesWindow: BrowserWindow | null = null;
	private releaseNotesView: BrowserView | null = null;
	private shortcuts: Map<string, ShortcutOptions> = new Map();
	private notificationCounter = 0;
	private sendToWebview: SendToWebview | null = null;
	private _windowFocused = true;
	private _windowHidden = false;
	private _focusPoller: ReturnType<typeof setInterval> | null = null;
	private _appActive = false;

	// Callback to open the settings window (set by index.ts)
	private openSettingsCallback: ((tabHint?: string) => void) | null = null;
	private openSurfaceWindowCallback:
		| ((
				surface:
					| "chat"
					| "browser"
					| "release"
					| "triggers"
					| "plugins"
					| "connectors"
					| "cloud",
				browse?: string,
				alwaysOnTop?: boolean,
		  ) => Promise<DesktopManagedWindowSnapshot> | DesktopManagedWindowSnapshot)
		| null = null;
	private openAppWindowCallback:
		| ((options: {
				slug?: string;
				title: string;
				path: string;
				alwaysOnTop?: boolean;
		  }) =>
				| Promise<DesktopManagedWindowSnapshot>
				| DesktopManagedWindowSnapshot)
		| null = null;
	private managedWindowAlwaysOnTopCallback:
		| ((id: string, flag: boolean) => boolean)
		| null = null;
	private openExternalHandler:
		| ((url: string) => boolean | Promise<boolean>)
		| null = null;
	private requestQuitCallback: (() => void | Promise<void>) | null = null;
	private restoreMainWindowCallback: (() => void | Promise<void>) | null = null;

	// Track menu items for context-menu-clicked matching
	private trayMenuItems: Map<string, TrayMenuItem> = new Map();
	private trayClickHandler: (() => void) | null = null;
	private contextMenuHandler: ElectrobunEventHandler | null = null;
	private windowEventHandlers: Partial<
		Record<"focus" | "blur" | "close" | "resize" | "move", () => void>
	> = {};
	private appExitStarted = false;

	constructor() {
		activeDesktopManager = this;
		this.ensureNativeContextMenuEvents();
	}

	// MARK: - Configuration

	/**
	 * Set the main BrowserWindow reference and wire up window events.
	 */
	setMainWindow(window: BrowserWindow): void {
		if (this.mainWindow === window) {
			return;
		}

		this.teardownWindowEvents(this.mainWindow);
		this.mainWindow = window;
		this.setupWindowEvents();
	}

	async getShellDiagnosticsState(): Promise<{
		trayPresent: boolean;
		mainWindowPresent: boolean;
		windowVisible: boolean;
		windowFocused: boolean;
	}> {
		return {
			trayPresent: Boolean(this.tray),
			mainWindowPresent: Boolean(this.mainWindow),
			windowVisible: (await this.isWindowVisible()).visible,
			windowFocused: this._windowFocused,
		};
	}

	/**
	 * Set the callback used to push messages to the webview renderer.
	 */
	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	/**
	 * Set the callback used to open the settings window from menus.
	 */
	setOpenSettingsCallback(cb: (tabHint?: string) => void): void {
		this.openSettingsCallback = cb;
	}

	/**
	 * Set the callback used to open detached surface windows from RPC or menus.
	 */
	setOpenSurfaceWindowCallback(
		cb: (
			surface:
				| "chat"
				| "browser"
				| "release"
				| "triggers"
				| "plugins"
				| "connectors"
				| "cloud",
			browse?: string,
			alwaysOnTop?: boolean,
		) => Promise<DesktopManagedWindowSnapshot> | DesktopManagedWindowSnapshot,
	): void {
		this.openSurfaceWindowCallback = cb;
	}

	setOpenAppWindowCallback(
		cb:
			| ((options: {
					slug?: string;
					title: string;
					path: string;
					alwaysOnTop?: boolean;
			  }) =>
					| Promise<DesktopManagedWindowSnapshot>
					| DesktopManagedWindowSnapshot)
			| null,
	): void {
		this.openAppWindowCallback = cb;
	}

	setManagedWindowAlwaysOnTopCallback(
		cb: ((id: string, flag: boolean) => boolean) | null,
	): void {
		this.managedWindowAlwaysOnTopCallback = cb;
	}

	/**
	 * Optionally handle trusted external URLs inside an app-managed window.
	 */
	setOpenExternalHandler(
		cb: ((url: string) => boolean | Promise<boolean>) | null,
	): void {
		this.openExternalHandler = cb;
	}

	setRequestQuitCallback(cb: (() => void | Promise<void>) | null): void {
		this.requestQuitCallback = cb;
	}

	setRestoreMainWindowCallback(cb: (() => void | Promise<void>) | null): void {
		this.restoreMainWindowCallback = cb;
	}

	clearMainWindow(window?: BrowserWindow | null): void {
		if (!window || this.mainWindow === window) {
			this.teardownWindowEvents(this.mainWindow);
			this.mainWindow = null;
		}
	}

	/**
	 * Open the settings window via the registered callback.
	 */
	openSettings(tabHint?: string): void {
		this.openSettingsCallback?.(tabHint);
	}

	/**
	 * Open a detached surface window via the registered callback.
	 */
	openSurfaceWindow(
		surface:
			| "chat"
			| "browser"
			| "release"
			| "triggers"
			| "plugins"
			| "connectors"
			| "cloud",
		browse?: string,
		alwaysOnTop?: boolean,
	): Promise<DesktopManagedWindowSnapshot | null> {
		return Promise.resolve(
			this.openSurfaceWindowCallback?.(surface, browse, alwaysOnTop) ?? null,
		);
	}

	async openAppWindow(options: {
		slug?: string;
		title: string;
		path: string;
		alwaysOnTop?: boolean;
	}): Promise<DesktopManagedWindowSnapshot | null> {
		return this.openAppWindowCallback?.(options) ?? null;
	}

	setManagedWindowAlwaysOnTop(id: string, flag: boolean): boolean {
		return this.managedWindowAlwaysOnTopCallback?.(id, flag) ?? false;
	}

	private getWindow(): BrowserWindow | null {
		return this.mainWindow ?? null;
	}

	private send(message: string, payload?: unknown): void {
		if (this.sendToWebview) {
			this.sendToWebview(message, payload);
		}
	}

	private ensureNativeContextMenuEvents(): void {
		activeDesktopManager = this;
		if (nativeContextMenuEventsInstalled) {
			return;
		}

		nativeContextMenuEventsInstalled = true;
		ContextMenu.on("context-menu-clicked", (event) => {
			activeDesktopManager?.handleNativeContextMenuClick(
				event as {
					data?: {
						action?: string;
						data?: { text?: string };
					};
				},
			);
		});
	}

	private handleNativeContextMenuClick(event: {
		data?: { action?: string; data?: { text?: string } };
	}): void {
		const action = event.data?.action;
		const text = event.data?.data?.text?.trim();

		if (!action) {
			return;
		}

		if (action === "copy-selection") {
			if (text) {
				Utils.clipboardWriteText(text);
			}
			return;
		}

		if (!text) {
			return;
		}

		if (action === "ask-agent") {
			this.send("contextMenuAskAgent", { text });
			return;
		}

		if (action === "quote-in-chat") {
			this.send("contextMenuQuoteInChat", { text });
			return;
		}

		if (action === "create-skill") {
			this.send("contextMenuCreateSkill", { text });
			return;
		}

		if (action === "save-as-command") {
			this.send("contextMenuSaveAsCommand", { text });
		}
	}

	// MARK: - System Tray

	async createTray(options: TrayOptions): Promise<void> {
		if (this.tray) {
			await this.destroyTray();
		}

		const iconPath = this.resolveIconPath(options.icon);

		this.tray = new Tray({
			title: options.tooltip ?? options.title ?? "",
			image: iconPath,
		});

		if (options.title && process.platform === "darwin") {
			this.tray.setTitle(options.title);
		}

		if (options.menu) {
			this.setTrayMenu({ menu: options.menu });
		}

		this.setupTrayEvents();
	}

	async updateTray(options: Partial<TrayOptions>): Promise<void> {
		if (!this.tray) return;

		if (options.icon) {
			const iconPath = this.resolveIconPath(options.icon);
			this.tray.setImage(iconPath);
		}

		if (options.title !== undefined && process.platform === "darwin") {
			this.tray.setTitle(options.title);
		}

		if (options.menu) {
			this.setTrayMenu({ menu: options.menu });
		}
	}

	async destroyTray(): Promise<void> {
		this.teardownTrayEvents();
		if (this.tray) {
			this.tray.remove();
			this.tray = null;
		}
		this.trayMenuItems.clear();
	}

	setTrayMenu(options: { menu: TrayMenuItem[] }): void {
		if (!this.tray) return;

		// Store menu items for action matching
		this.trayMenuItems.clear();
		this.indexMenuItems(options.menu);

		const template = this.buildMenuTemplate(options.menu);
		this.tray.setMenu(template);
	}

	/**
	 * Recursively index menu items by id for context-menu-clicked matching.
	 */
	private indexMenuItems(items: TrayMenuItem[]): void {
		for (const item of items) {
			if (item.id) {
				this.trayMenuItems.set(item.id, item);
			}
			if (item.submenu) {
				this.indexMenuItems(item.submenu);
			}
		}
	}

	/**
	 * Convert TrayMenuItem[] to Electrobun's menu format.
	 * Electrobun uses { type, label, action, submenu? }.
	 */
	private buildMenuTemplate(items: TrayMenuItem[]): MenuItemConfig[] {
		return items.map((item): MenuItemConfig => {
			if (item.type === "separator") {
				return { type: "separator" };
			}

			const menuItem: MenuItemConfig & { type: "normal" } = {
				type: "normal",
				label: item.label ?? "",
				// Use the item id as the action identifier for matching clicks
				action: item.id,
			};

			if (item.enabled === false) {
				menuItem.enabled = false;
			}

			if (item.submenu) {
				menuItem.submenu = this.buildMenuTemplate(item.submenu);
			}

			return menuItem;
		});
	}

	private setupTrayEvents(): void {
		if (!this.tray) return;

		this.teardownTrayEvents();

		// Electrobun tray click is simpler — no bounds/modifiers
		this.trayClickHandler = () => {
			void this.showWindow().catch((err: unknown) => {
				logger.warn(
					`[Desktop] Failed to show window from tray click: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
			this.send("desktopTrayClick", {
				x: 0,
				y: 0,
				button: "left",
				modifiers: { alt: false, shift: false, ctrl: false, meta: false },
			});
		};
		this.tray.on("tray-clicked", this.trayClickHandler);

		const triggerAgentRestart = () => {
			// Lazy import to avoid circular dependency (agent → desktop → agent).
			import("./agent").then(({ getAgentManager }) => {
				getAgentManager()
					.restart()
					.catch((err: unknown) => {
						logger.error(
							`[Desktop] Agent restart failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			});
		};

		// Tray menu item clicks fire "tray-clicked" on the global event bus
		// (NOT "context-menu-clicked" — that's for right-click context menus).
		// The event data shape is { data: { id, action, data? } }.
		// Electrobun emits ElectrobunEvent<TrayClickedData> for tray-clicked;
		// the shape carries { data: { action, id, data? } }.
		this.contextMenuHandler = ((e: { data?: { action?: string } }): void => {
			const action = e?.data?.action;
			if (!action) return;

			// Native actions — these must work even when the renderer RPC bridge
			// is not yet connected (e.g. PGLite init on Windows can take 240s).
			if (action === "show" || action === "tray-show-window") {
				void this.showWindow().catch((err: unknown) => {
					logger.warn(
						`[Desktop] Failed to show window from tray menu: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			} else if (action === "tray-hide-window") {
				void this.hideWindow().catch((err: unknown) => {
					logger.warn(
						`[Desktop] Failed to hide window from tray menu: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			} else if (action === "restart-agent" || action === "tray-restart") {
				triggerAgentRestart();
			} else if (action === "quit") {
				Utils.quit();
			} else if (action === "open-settings") {
				this.openSettingsCallback?.();
			}

			// Renderer notification for all items
			const menuItem = this.trayMenuItems.get(action);
			if (menuItem) {
				this.send("desktopTrayMenuClick", {
					itemId: menuItem.id,
					checked:
						menuItem.type === "checkbox" ? !menuItem.checked : menuItem.checked,
				});
			}
		}) as ElectrobunEventHandler;
		Electrobun.events.on(
			"tray-clicked",
			this.contextMenuHandler as ElectrobunEventHandler,
		);
	}

	private teardownTrayEvents(): void {
		this.removeEventHandler(this.tray, "tray-clicked", this.trayClickHandler);
		this.removeEventHandler(
			Electrobun.events,
			"tray-clicked",
			this.contextMenuHandler,
		);
		this.trayClickHandler = null;
		this.contextMenuHandler = null;
	}

	private removeEventHandler(
		target: unknown,
		event: string,
		handler: ElectrobunEventHandler | null | undefined,
	): void {
		const eventTarget = target as ElectrobunEventTarget | null | undefined;
		if (!eventTarget || !handler) {
			return;
		}

		if (typeof eventTarget.off === "function") {
			eventTarget.off(event, handler);
			return;
		}

		if (typeof eventTarget.removeListener === "function") {
			eventTarget.removeListener(event, handler);
		}
	}

	// MARK: - Global Shortcuts

	async registerShortcut(
		options: ShortcutOptions,
	): Promise<{ success: boolean }> {
		// Unregister existing shortcut with same id
		if (this.shortcuts.has(options.id)) {
			const existing = this.shortcuts.get(options.id);
			if (existing) {
				GlobalShortcut.unregister(existing.accelerator);
			}
		}

		try {
			GlobalShortcut.register(options.accelerator, () => {
				this.send("desktopShortcutPressed", {
					id: options.id,
					accelerator: options.accelerator,
				});
			});
			this.shortcuts.set(options.id, options);
			return { success: true };
		} catch {
			return { success: false };
		}
	}

	async unregisterShortcut(options: { id: string }): Promise<void> {
		const shortcut = this.shortcuts.get(options.id);
		if (shortcut) {
			GlobalShortcut.unregister(shortcut.accelerator);
			this.shortcuts.delete(options.id);
		}
	}

	async unregisterAllShortcuts(): Promise<void> {
		GlobalShortcut.unregisterAll();
		this.shortcuts.clear();
	}

	async isShortcutRegistered(options: {
		accelerator: string;
	}): Promise<{ registered: boolean }> {
		return { registered: GlobalShortcut.isRegistered(options.accelerator) };
	}

	// MARK: - Auto Launch

	async setAutoLaunch(options: {
		enabled: boolean;
		openAsHidden?: boolean;
	}): Promise<void> {
		const appPath = process.execPath;

		const openAsHidden = options.openAsHidden ?? false;

		if (process.platform === "darwin") {
			await this.setAutoLaunchMac(options.enabled, appPath, openAsHidden);
		} else if (process.platform === "linux") {
			this.setAutoLaunchLinux(options.enabled, appPath, openAsHidden);
		} else if (process.platform === "win32") {
			await this.setAutoLaunchWin(options.enabled, appPath, openAsHidden);
		} else {
			logger.warn(
				`[DesktopManager] setAutoLaunch: unsupported platform ${process.platform}`,
			);
		}
	}

	async getAutoLaunchStatus(): Promise<{
		enabled: boolean;
		openAsHidden: boolean;
	}> {
		if (process.platform === "darwin") {
			const plistPath = this.getMacLaunchAgentPath();
			if (!fs.existsSync(plistPath))
				return { enabled: false, openAsHidden: false };
			const content = fs.readFileSync(plistPath, "utf8");
			return { enabled: true, openAsHidden: content.includes("--hidden") };
		}

		if (process.platform === "linux") {
			const desktopPath = this.getLinuxAutostartPath();
			if (!fs.existsSync(desktopPath))
				return { enabled: false, openAsHidden: false };
			const content = fs.readFileSync(desktopPath, "utf8");
			return { enabled: true, openAsHidden: content.includes("--hidden") };
		}

		if (process.platform === "win32") {
			const { enabled, openAsHidden } = await this.getAutoLaunchStatusWin();
			return { enabled, openAsHidden };
		}

		return { enabled: false, openAsHidden: false };
	}

	// MARK: - Auto-launch helpers (macOS)

	private getMacLaunchAgentPath(): string {
		return path.join(
			os.homedir(),
			"Library",
			"LaunchAgents",
			getBrandConfig().macLaunchAgentPlist,
		);
	}

	private async setAutoLaunchMac(
		enabled: boolean,
		appPath: string,
		openAsHidden = false,
	): Promise<void> {
		const plistPath = this.getMacLaunchAgentPath();

		if (enabled) {
			const hiddenArg = openAsHidden ? "\n    <string>--hidden</string>" : "";
			const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${getBrandConfig().macLaunchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appPath}</string>${hiddenArg}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
			const dir = path.dirname(plistPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(plistPath, plistContent, "utf8");

			const proc = Bun.spawn(["launchctl", "load", plistPath], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
		} else {
			if (fs.existsSync(plistPath)) {
				const proc = Bun.spawn(["launchctl", "unload", plistPath], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				fs.unlinkSync(plistPath);
			}
		}
	}

	// MARK: - Auto-launch helpers (Linux)

	private getLinuxAutostartPath(): string {
		return path.join(
			os.homedir(),
			".config",
			"autostart",
			getBrandConfig().linuxDesktopFileName,
		);
	}

	private setAutoLaunchLinux(
		enabled: boolean,
		appPath: string,
		openAsHidden = false,
	): void {
		const desktopPath = this.getLinuxAutostartPath();

		if (enabled) {
			const execLine = openAsHidden ? `${appPath} --hidden` : appPath;
			const desktopContent = `[Desktop Entry]
Type=Application
Name=${getBrandConfig().linuxDesktopEntryName}
Exec=${execLine}
X-GNOME-Autostart-enabled=true
`;
			const dir = path.dirname(desktopPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(desktopPath, desktopContent, "utf8");
		} else {
			if (fs.existsSync(desktopPath)) {
				fs.unlinkSync(desktopPath);
			}
		}
	}

	// MARK: - Auto-launch helpers (Windows)

	private readonly WIN_REG_KEY =
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

	private async setAutoLaunchWin(
		enabled: boolean,
		appPath: string,
		openAsHidden = false,
	): Promise<void> {
		if (enabled) {
			const launchValue = openAsHidden ? `${appPath} --hidden` : appPath;
			const proc = Bun.spawn(
				[
					"reg",
					"add",
					this.WIN_REG_KEY,
					"/v",
					getBrandConfig().windowsRegistryValueName,
					"/t",
					"REG_SZ",
					"/d",
					launchValue,
					"/f",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;
		} else {
			const proc = Bun.spawn(
				[
					"reg",
					"delete",
					this.WIN_REG_KEY,
					"/v",
					getBrandConfig().windowsRegistryValueName,
					"/f",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;
		}
	}

	private async getAutoLaunchStatusWin(): Promise<{
		enabled: boolean;
		openAsHidden: boolean;
	}> {
		try {
			const proc = Bun.spawn(
				[
					"reg",
					"query",
					this.WIN_REG_KEY,
					"/v",
					getBrandConfig().windowsRegistryValueName,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);
			if (!stdout.includes(getBrandConfig().windowsRegistryValueName))
				return { enabled: false, openAsHidden: false };
			return { enabled: true, openAsHidden: stdout.includes("--hidden") };
		} catch {
			return { enabled: false, openAsHidden: false };
		}
	}

	// MARK: - Window Management

	async setWindowOptions(options: WindowOptions): Promise<void> {
		const win = this.getWindow();
		if (!win) return;

		if (options.width !== undefined || options.height !== undefined) {
			const { width: currentW, height: currentH } = win.getSize();
			win.setSize(options.width ?? currentW, options.height ?? currentH);
		}

		if (options.x !== undefined || options.y !== undefined) {
			const { x: currentX, y: currentY } = win.getPosition();
			win.setPosition(options.x ?? currentX, options.y ?? currentY);
		}

		// minWidth/minHeight/maxWidth/maxHeight — not directly supported
		// in Electrobun BrowserWindow. Skip silently.

		if (options.alwaysOnTop !== undefined) {
			win.setAlwaysOnTop(options.alwaysOnTop);
		}

		if (options.fullscreen !== undefined) {
			win.setFullScreen(options.fullscreen);
		}

		// opacity — no setOpacity in Electrobun (no-op)
		if (options.opacity !== undefined) {
			// No-op: Electrobun BrowserWindow does not support setOpacity
		}

		if (options.title !== undefined) {
			win.setTitle(options.title);
		}

		// resizable — not directly settable post-creation in Electrobun.
		// Skip silently.
	}

	async getWindowBounds(): Promise<WindowBounds> {
		const win = this.getWindow();
		if (!win) return { x: 0, y: 0, width: 0, height: 0 };
		const { x, y } = win.getPosition();
		const { width, height } = win.getSize();
		return { x, y, width, height };
	}

	async setWindowBounds(options: WindowBounds): Promise<void> {
		const win = this.getWindow();
		if (!win) return;
		win.setPosition(options.x, options.y);
		win.setSize(options.width, options.height);
	}

	async minimizeWindow(): Promise<void> {
		this.getWindow()?.minimize();
	}

	async unminimizeWindow(): Promise<void> {
		this.getWindow()?.unminimize();
	}

	async maximizeWindow(): Promise<void> {
		this.getWindow()?.maximize();
	}

	async unmaximizeWindow(): Promise<void> {
		this.getWindow()?.unmaximize();
	}

	async closeWindow(): Promise<void> {
		this.getWindow()?.close();
	}

	async showWindow(): Promise<void> {
		let win = this.mainWindow;
		if (!win) {
			await this.restoreMainWindowCallback?.();
			win = this.mainWindow;
		}
		if (!win) return;
		try {
			this.showMainWindow(win);
		} catch {
			this.clearMainWindow(win);
			await this.restoreMainWindowCallback?.();
			win = this.mainWindow;
			if (!win) return;
			this.showMainWindow(win);
		}
	}

	async hideWindow(): Promise<void> {
		const win = this.mainWindow;
		if (!win) return;
		const ptr = (win as { ptr?: unknown }).ptr;
		if (ptr && process.platform === "darwin") {
			// orderOut removes the window from screen AND Cmd+Tab / Mission Control
			orderOut(ptr as Parameters<typeof orderOut>[0]);
		} else {
			// Non-macOS fallback: minimize
			win.minimize();
		}
		this._windowHidden = true;
	}

	async focusWindow(): Promise<void> {
		this.getWindow()?.focus();
	}

	async isWindowMaximized(): Promise<{ maximized: boolean }> {
		const win = this.getWindow();
		return { maximized: win ? win.isMaximized() : false };
	}

	async isWindowMinimized(): Promise<{ minimized: boolean }> {
		const win = this.getWindow();
		return { minimized: win ? win.isMinimized() : false };
	}

	async isWindowVisible(): Promise<{ visible: boolean }> {
		if (this._windowHidden) return { visible: false };
		const win = this.getWindow();
		if (!win) return { visible: false };
		return { visible: !win.isMinimized() };
	}

	async isWindowFocused(): Promise<{ focused: boolean }> {
		return { focused: this._windowFocused };
	}

	async setAlwaysOnTop(options: SetAlwaysOnTopOptions): Promise<void> {
		// Electrobun setAlwaysOnTop takes a boolean — ignore level
		this.getWindow()?.setAlwaysOnTop(options.flag);
	}

	async setFullscreen(options: SetFullscreenOptions): Promise<void> {
		this.getWindow()?.setFullScreen(options.flag);
	}

	async setOpacity(_options: SetOpacityOptions): Promise<void> {
		// No-op: Electrobun BrowserWindow does not support setOpacity
	}

	private showMainWindow(win: BrowserWindow): void {
		const ptr = (win as { ptr?: unknown }).ptr;
		if (ptr && process.platform === "darwin") {
			makeKeyAndOrderFront(ptr as Parameters<typeof makeKeyAndOrderFront>[0]);
		} else {
			win.show();
			win.focus();
		}
		this._windowHidden = false;
	}

	private setupWindowEvents(): void {
		const win = this.mainWindow;
		if (!win) return;

		const focusHandler = () => {
			this._windowFocused = true;
			this.send("desktopWindowFocus");
		};
		this.windowEventHandlers.focus = focusHandler;
		win.on("focus", focusHandler);

		// Blur via native event (Electrobun may not surface this, but try it for free)
		const blurHandler = () => {
			this._windowFocused = false;
			this.send("desktopWindowBlur");
		};
		this.windowEventHandlers.blur = blurHandler;
		win.on("blur", blurHandler);

		const closeHandler = () => {
			this.send("desktopWindowClose");
		};
		this.windowEventHandlers.close = closeHandler;
		win.on("close", closeHandler);

		const resizeHandler = () => {
			// Electrobun fires resize but doesn't distinguish maximize/unmaximize.
			// We detect state changes to emit the right event.
			if (win.isMaximized()) {
				this.send("desktopWindowMaximize");
			}
		};
		this.windowEventHandlers.resize = resizeHandler;
		win.on("resize", resizeHandler);

		let wasMaximized = false;
		const moveHandler = () => {
			// Only emit desktopWindowUnmaximize when transitioning FROM maximized
			// to not-maximized, not on every move during a normal window drag.
			const isMaximized = win.isMaximized();
			if (wasMaximized && !isMaximized) {
				this.send("desktopWindowUnmaximize");
			}
			wasMaximized = isMaximized;
		};
		this.windowEventHandlers.move = moveHandler;
		win.on("move", moveHandler);

		// Blur fallback: poll [NSWindow isKeyWindow] at 2Hz on macOS.
		// Electrobun does not guarantee blur events, so this gives bounded
		// ≤500ms latency for focus-loss detection.
		if (process.platform === "darwin") {
			this._startFocusPoller();
		}
	}

	private teardownWindowEvents(window: BrowserWindow | null): void {
		if (!window) {
			return;
		}

		this.removeEventHandler(window, "focus", this.windowEventHandlers.focus);
		this.removeEventHandler(window, "blur", this.windowEventHandlers.blur);
		this.removeEventHandler(window, "close", this.windowEventHandlers.close);
		this.removeEventHandler(window, "resize", this.windowEventHandlers.resize);
		this.removeEventHandler(window, "move", this.windowEventHandlers.move);
		this.windowEventHandlers = {};
	}

	private _startFocusPoller(): void {
		if (this._focusPoller) return;
		this._focusPoller = setInterval(() => {
			const win = this.mainWindow;
			if (!win) return;

			// Electrobun does not expose an application activation callback.
			// When the app becomes foreground again with only a minimized window
			// (for example via Dock click), restore it automatically.
			const appActive = isAppActive();
			if (!this._appActive && appActive && win.isMinimized()) {
				void this.showWindow();
			}
			this._appActive = appActive;

			const ptr = (win as { ptr?: unknown }).ptr;
			if (!ptr) return;
			const focused = isKeyWindow(ptr as Parameters<typeof isKeyWindow>[0]);
			if (focused !== this._windowFocused) {
				this._windowFocused = focused;
				if (!focused) {
					this.send("desktopWindowBlur");
				}
			}
		}, 500);
	}

	// MARK: - Notifications

	async showNotification(
		options: NotificationOptions,
	): Promise<{ id: string }> {
		const id = `notification_${++this.notificationCounter}`;

		// Electrobun Utils.showNotification — fire-and-forget, no event callbacks
		Utils.showNotification({
			title: options.title,
			body: options.body,
			subtitle: undefined,
			silent: options.silent,
		});

		return { id };
	}

	async closeNotification(_options: { id: string }): Promise<void> {
		// Electrobun does not support programmatic notification dismissal.
		// No-op.
	}

	// MARK: - Power Monitor

	async getPowerState(): Promise<PowerState> {
		try {
			if (process.platform === "darwin") {
				const powerSource = parseMacOsPowerSourceOutput(
					await readProcessStdout(["pmset", "-g", "batt"]),
				);
				const idleTime =
					parseMacOsHidIdleTimeOutput(
						await readProcessStdout(["ioreg", "-c", "IOHIDSystem"]),
					) ?? 0;
				const locked = fs.existsSync(MACOS_CGSESSION_PATH)
					? parseMacOsSessionLockedOutput(
							await readProcessStdout([
								MACOS_CGSESSION_PATH,
								"-currentSession",
							]),
						)
					: null;
				const idleState =
					locked === true
						? "locked"
						: idleTime >= MACOS_IDLE_THRESHOLD_SECONDS
							? "idle"
							: locked === false
								? "active"
								: "unknown";
				return {
					onBattery: powerSource.known ? powerSource.onBattery : false,
					idleState,
					idleTime,
				};
			}
			if (process.platform === "linux") {
				const idleOutput = await readProcessStdoutSafe(["xprintidle"]);
				const idleTime =
					idleOutput !== null ? (parseXprintidleOutput(idleOutput) ?? 0) : 0;
				const locked = await readLinuxLockedHint();
				const idleState =
					locked === true
						? "locked"
						: idleOutput === null
							? "unknown"
							: idleTime >= LINUX_IDLE_THRESHOLD_SECONDS
								? "idle"
								: locked === false
									? "active"
									: "active";
				return {
					onBattery: linuxSysfsOnBattery(),
					idleState,
					idleTime,
				};
			}
			if (process.platform === "win32") {
				const batteryOutput = await readProcessStdoutSafe([
					"powershell",
					"-NoProfile",
					"-NoLogo",
					"-Command",
					"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString()",
				]);
				const batteryParsed = batteryOutput
					? parseWindowsPowerLineOutput(batteryOutput)
					: { onBattery: false, known: false };
				const idleOutput = await readProcessStdoutSafe([
					"powershell",
					"-NoProfile",
					"-NoLogo",
					"-Command",
					WINDOWS_IDLE_POWERSHELL_SCRIPT,
				]);
				const idleTime =
					idleOutput !== null
						? (parseWindowsIdleTimeOutput(idleOutput) ?? 0)
						: 0;
				const lockOutput = await readProcessStdoutSafe([
					"powershell",
					"-NoProfile",
					"-NoLogo",
					"-Command",
					"(Get-Process logonui -ErrorAction SilentlyContinue).Count",
				]);
				const locked = lockOutput
					? parseWindowsLockStateOutput(lockOutput)
					: null;
				const idleState =
					locked === true
						? "locked"
						: idleOutput === null
							? "unknown"
							: idleTime >= WINDOWS_IDLE_THRESHOLD_SECONDS
								? "idle"
								: "active";
				return {
					onBattery: batteryParsed.known ? batteryParsed.onBattery : false,
					idleState,
					idleTime,
				};
			}
		} catch {
			// Fall through to stub below
		}
		return { onBattery: false, idleState: "unknown", idleTime: 0 };
	}

	// MARK: - App

	private async beginAppExit(reason: string): Promise<void> {
		if (this.appExitStarted) {
			return;
		}
		this.appExitStarted = true;
		await this.showWindow().catch(() => {});
		this.send("desktopShutdownStarted", { reason });
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	async quit(): Promise<void> {
		await this.beginAppExit("desktop-quit");
		if (this.requestQuitCallback) {
			await this.requestQuitCallback();
			return;
		}
		Utils.quit();
	}

	async relaunch(): Promise<void> {
		await this.beginAppExit("desktop-relaunch");
		try {
			const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
				detached: true,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
			// Detach so the new instance survives the parent quitting
			child.unref?.();
		} catch (err) {
			logger.error(
				`[DesktopManager] relaunch: failed to spawn new instance: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		Utils.quit();
	}

	async getVersion(): Promise<VersionInfo> {
		let version = "0.0.0";
		try {
			version = await Updater.localInfo.version();
		} catch {
			// Updater may not be available in dev
		}

		return {
			version,
			name: getBrandConfig().appName,
			runtime: `electrobun/${Bun.version}`,
		};
	}

	async isPackaged(): Promise<{ packaged: boolean }> {
		// In Electrobun, check if running from a built bundle
		// DEV mode typically has specific env flags
		return {
			packaged:
				process.env.NODE_ENV === "production" || !process.env.ELECTROBUN_DEV,
		};
	}

	async getPath(options: { name: string }): Promise<{ path: string }> {
		const mapped = PATH_NAME_MAP[options.name];
		if (typeof mapped === "function") {
			return { path: mapped() };
		}
		if (typeof mapped === "string") {
			return { path: mapped };
		}

		// Fallback: try to return a sensible default under userData
		logger.warn(
			`[DesktopManager] Unknown path name "${options.name}", falling back to userData`,
		);
		return { path: Utils.paths.userData };
	}

	async getStartupDiagnostics(): Promise<{
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
	}> {
		const snapshot = getStartupDiagnosticsSnapshot();
		const version = await this.getVersion();
		const packaged = await this.isPackaged();
		const locale = Intl.DateTimeFormat().resolvedOptions().locale;
		return {
			...snapshot,
			logTail: getStartupDiagnosticLogTail(),
			appVersion: version.version,
			appRuntime: version.runtime,
			packaged: packaged.packaged,
			locale,
		};
	}

	async openLogsFolder(): Promise<void> {
		const diagnostics = getStartupDiagnosticsSnapshot();
		const folderPath = path.dirname(diagnostics.logPath);
		Utils.openPath(folderPath);
	}

	async createBugReportBundle(options: {
		reportMarkdown: string;
		reportJson: Record<string, unknown>;
		prefix?: string;
	}): Promise<{
		directory: string;
		reportMarkdownPath: string;
		reportJsonPath: string;
		startupLogPath: string | null;
		startupStatusPath: string | null;
	}> {
		return createBugReportBundle(options);
	}

	async checkForUpdates(): Promise<DesktopUpdaterSnapshot> {
		const availability = this.getUpdaterAvailability();
		if (!availability.canAutoUpdate) {
			return this.buildUpdaterSnapshot(undefined, availability);
		}

		try {
			const result = await Updater.checkForUpdate();
			if (result?.updateAvailable) {
				void this.downloadUpdateWithRetry().catch((error: unknown) => {
					logger.warn(
						`[Desktop] Update download failed after retries: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
			return await this.getUpdaterState();
		} catch (error) {
			return this.buildUpdaterSnapshot(error, availability);
		}
	}

	async getUpdaterState(): Promise<DesktopUpdaterSnapshot> {
		return this.buildUpdaterSnapshot();
	}

	private async downloadUpdateWithRetry(
		maxAttempts = 3,
		baseDelayMs = 2_000,
	): Promise<void> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await Updater.downloadUpdate();
				return;
			} catch (error) {
				const isLastAttempt = attempt === maxAttempts;
				if (isLastAttempt) throw error;
				const delay = baseDelayMs * 2 ** (attempt - 1);
				logger.warn(
					`[Desktop] Update download attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	async applyUpdate(): Promise<void> {
		const availability = this.getUpdaterAvailability();
		if (!availability.canAutoUpdate) {
			throw new Error(
				availability.autoUpdateDisabledReason ??
					"Auto-update is unavailable for this installation.",
			);
		}

		Updater.applyUpdate();
	}

	async getBuildInfo(): Promise<DesktopBuildInfo> {
		const config = await BuildConfig.get();
		return {
			platform: process.platform,
			arch: process.arch,
			defaultRenderer: config.defaultRenderer,
			availableRenderers: config.availableRenderers,
			cefVersion: config.cefVersion,
			bunVersion: config.bunVersion,
			runtime: config.runtime,
		};
	}

	async getDockIconVisibility(): Promise<{ visible: boolean }> {
		if (process.platform !== "darwin") {
			return { visible: true };
		}

		return {
			visible: Utils.isDockIconVisible?.() ?? true,
		};
	}

	async setDockIconVisibility(options: {
		visible: boolean;
	}): Promise<{ visible: boolean }> {
		if (process.platform === "darwin") {
			Utils.setDockIconVisible?.(options.visible);
		}

		return this.getDockIconVisibility();
	}

	async showSelectionContextMenu(options: {
		text: string;
	}): Promise<{ shown: boolean }> {
		const text = options.text.trim();
		if (!text) {
			return { shown: false };
		}

		const menu: ApplicationMenuItemConfig[] = [
			{
				type: "normal",
				label: "Ask Agent",
				action: "ask-agent",
				data: { text },
			},
			{
				type: "normal",
				label: "Quote in Chat",
				action: "quote-in-chat",
				data: { text },
			},
			{
				type: "normal",
				label: "Create Skill",
				action: "create-skill",
				data: { text },
			},
			{
				type: "normal",
				label: "Save as Command",
				action: "save-as-command",
				data: { text },
			},
			{ type: "separator" },
			{
				type: "normal",
				label: "Copy Selection",
				action: "copy-selection",
				data: { text },
			},
		];

		ContextMenu.showContextMenu(menu);
		return { shown: true };
	}

	async getSessionSnapshot(options: {
		partition: string;
	}): Promise<DesktopSessionSnapshot> {
		return this.readSessionSnapshot(options.partition);
	}

	async clearSessionData(options: {
		partition: string;
		storageTypes?: DesktopSessionStorageType[] | "all";
		clearCookies?: boolean;
	}): Promise<DesktopSessionSnapshot> {
		const session = this.getSession(options.partition);
		const shouldClearCookies =
			options.clearCookies === true ||
			options.storageTypes === "all" ||
			options.storageTypes?.includes("cookies");

		if (shouldClearCookies) {
			session.cookies.clear();
		}

		if (options.storageTypes === "all") {
			session.clearStorageData("all");
		} else if (options.storageTypes) {
			const storageTypes = options.storageTypes.filter(
				(type) => type !== "cookies",
			);
			if (storageTypes.length > 0) {
				session.clearStorageData(
					storageTypes as Exclude<DesktopSessionStorageType, "cookies">[],
				);
			}
		}

		return this.readSessionSnapshot(options.partition);
	}

	async getWebGpuBrowserStatus(): Promise<
		ReturnType<typeof checkWebGpuSupport>
	> {
		const config = await BuildConfig.get();
		return checkWebGpuSupport(this.resolvePreferredBrowserRenderer(config));
	}

	async openReleaseNotesWindow(options: {
		url: string;
		title?: string;
	}): Promise<DesktopReleaseNotesWindowInfo> {
		const url = this.normalizeReleaseNotesUrl(options.url);
		const title =
			options.title?.trim() || `${getBrandConfig().appName} Release Notes`;

		if (this.releaseNotesWindow && this.releaseNotesView) {
			this.releaseNotesWindow.setTitle(title);
			if (this.releaseNotesView.url !== url) {
				this.releaseNotesView.loadURL(url);
			}
			this.releaseNotesWindow.focus();
			return {
				url,
				windowId: this.releaseNotesWindow.id,
				webviewId: this.releaseNotesView.id,
			};
		}

		const buildConfig = await BuildConfig.get();
		const renderer = this.resolvePreferredBrowserRenderer(buildConfig);
		const win = new Electrobun.BrowserWindow({
			title,
			frame: {
				x: 170,
				y: 110,
				width: 1180,
				height: 860,
			},
			renderer,
			transparent: false,
			titleBarStyle: "default",
		});

		// BrowserWindow always creates a default webview. Remove it so the
		// manual BrowserView becomes the only live browsing surface.
		win.webview.remove();

		const view = new BrowserView({
			url,
			renderer,
			windowId: win.id,
			partition: RELEASE_NOTES_PARTITION,
			sandbox: true,
			navigationRules: JSON.stringify(
				this.buildReleaseNotesNavigationRules(url),
			),
			frame: {
				x: 0,
				y: 0,
				width: win.frame.width,
				height: win.frame.height,
			},
		});

		win.on("close", () => {
			this.releaseNotesView?.remove();
			this.releaseNotesWindow = null;
			this.releaseNotesView = null;
		});

		this.releaseNotesWindow = win;
		this.releaseNotesView = view;
		win.focus();

		return {
			url,
			windowId: win.id,
			webviewId: view.id,
		};
	}

	// MARK: - Clipboard

	async writeToClipboard(options: ClipboardWriteOptions): Promise<void> {
		if (options.text) {
			Utils.clipboardWriteText(options.text);
		} else if (options.image) {
			// clipboardWriteImage expects a Uint8Array — decode base64 before passing.
			const bytes = Buffer.from(options.image, "base64");
			Utils.clipboardWriteImage(new Uint8Array(bytes));
		}
		// html/rtf not supported by Electrobun clipboard — drop silently
	}

	async readFromClipboard(): Promise<ClipboardReadResult> {
		const text = Utils.clipboardReadText();
		let hasImage = false;
		try {
			const imgData = Utils.clipboardReadImage();
			hasImage = !!imgData && imgData.length > 0;
		} catch {
			// clipboardReadImage may throw if no image data
		}

		return {
			text: text || undefined,
			// html/rtf not supported by Electrobun clipboard
			hasImage,
		};
	}

	async clearClipboard(): Promise<void> {
		Utils.clipboardClear();
	}

	async clipboardAvailableFormats(): Promise<{ formats: string[] }> {
		const formats = Utils.clipboardAvailableFormats?.() ?? [];
		return { formats: Array.isArray(formats) ? formats : [] };
	}

	// MARK: - Shell

	/**
	 * Open an external URL in the default browser.
	 * SECURITY: restricted to http/https to prevent opening arbitrary protocols.
	 */
	async openExternal(options: OpenExternalOptions): Promise<void> {
		const url = typeof options.url === "string" ? options.url.trim() : "";
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(
					`Blocked openExternal for non-http(s) URL: ${parsed.protocol}`,
				);
			}
		} catch (err) {
			if (err instanceof TypeError) {
				throw new Error(`Invalid URL passed to openExternal: ${url}`);
			}
			throw err;
		}

		if (this.openExternalHandler) {
			try {
				const handled = await this.openExternalHandler(url);
				if (handled) {
					return;
				}
			} catch (err) {
				logger.warn(
					`[Desktop] openExternal handler failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		Utils.openExternal(url);
	}

	/**
	 * Reveal a file in the OS file manager.
	 * SECURITY: requires an absolute path.
	 */
	async showItemInFolder(options: ShowItemInFolderOptions): Promise<void> {
		const p = typeof options.path === "string" ? options.path.trim() : "";
		if (!p || !path.isAbsolute(p)) {
			throw new Error("showItemInFolder requires an absolute path");
		}
		Utils.showItemInFolder(p);
	}

	async openPath(options: { path: string }): Promise<void> {
		const p = typeof options.path === "string" ? options.path.trim() : "";
		if (!p) {
			throw new Error("openPath requires a non-empty path");
		}
		Utils.openPath(p);
	}

	async beep(): Promise<void> {
		try {
			if (process.platform === "darwin") {
				Bun.spawn(["afplay", "/System/Library/Sounds/Funk.aiff"], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} else if (process.platform === "linux") {
				// Try paplay (PulseAudio), fall back to terminal bell
				try {
					const proc = Bun.spawn(
						["paplay", "/usr/share/sounds/freedesktop/stereo/bell.oga"],
						{ stdout: "ignore", stderr: "ignore" },
					);
					await proc.exited;
				} catch {
					process.stdout.write("\x07");
				}
			} else if (process.platform === "win32") {
				const proc = Bun.spawn(
					["powershell", "-NoProfile", "-Command", "[Console]::Beep(800, 200)"],
					{ stdout: "ignore", stderr: "ignore" },
				);
				await proc.exited;
			}
		} catch {
			// beep is best-effort — never throw
		}
	}

	// MARK: - Screen / Display

	async getPrimaryDisplay(): Promise<DisplayInfo> {
		const display = Screen.getPrimaryDisplay();
		return {
			id: display.id ?? 0,
			bounds: display.bounds,
			workArea: display.workArea,
			scaleFactor: display.scaleFactor ?? 1,
			isPrimary: display.isPrimary ?? true,
		};
	}

	async getAllDisplays(): Promise<{ displays: DisplayInfo[] }> {
		const displays = Screen.getAllDisplays();
		return {
			displays: displays.map((d) => ({
				id: d.id ?? 0,
				bounds: d.bounds,
				workArea: d.workArea,
				scaleFactor: d.scaleFactor ?? 1,
				isPrimary: d.isPrimary ?? false,
			})),
		};
	}

	async getCursorPosition(): Promise<CursorPosition> {
		return Screen.getCursorScreenPoint();
	}

	// MARK: - Message Box

	async showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult> {
		const autoConfirm =
			process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1" ||
			process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_RESET === "1";
		if (autoConfirm) {
			return { response: options.defaultId ?? 0 };
		}
		const result = await Utils.showMessageBox({
			type: options.type ?? "info",
			title: options.title,
			message: options.message,
			detail: options.detail,
			buttons: options.buttons ?? ["OK"],
			defaultId: options.defaultId ?? 0,
			cancelId: options.cancelId,
		});
		return { response: result.response ?? result };
	}

	// MARK: - File Dialogs

	/**
	 * Show a native file/directory open picker.
	 * Maps to Electrobun's Utils.openFileDialog.
	 */
	async showOpenDialog(options: FileDialogOptions): Promise<FileDialogResult> {
		const filePaths = await Utils.openFileDialog({
			startingFolder: options.defaultPath,
			allowedFileTypes: options.allowedFileTypes,
			canChooseFiles: options.canChooseFiles ?? true,
			canChooseDirectory: options.canChooseDirectory ?? false,
			allowsMultipleSelection: options.allowsMultipleSelection ?? false,
		});
		const canceled = filePaths.length === 0 || filePaths[0] === "";
		return { canceled, filePaths: canceled ? [] : filePaths };
	}

	/**
	 * Show a native directory picker for save operations.
	 * Electrobun has no separate save dialog — we pick a directory and the
	 * caller appends the filename. Returns the chosen directory path.
	 */
	async showSaveDialog(options: FileDialogOptions): Promise<FileDialogResult> {
		const filePaths = await Utils.openFileDialog({
			startingFolder: options.defaultPath,
			allowedFileTypes: options.allowedFileTypes,
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		const canceled = filePaths.length === 0 || filePaths[0] === "";
		return { canceled, filePaths: canceled ? [] : filePaths };
	}

	// MARK: - Helpers

	/**
	 * Resolve an icon path, trying absolute, then relative to known asset dirs.
	 */
	private resolveIconPath(iconPath: string): string {
		if (path.isAbsolute(iconPath)) {
			return iconPath;
		}

		// Try relative to the electrobun assets directory
		const assetsPath = path.join(import.meta.dir, "../../assets", iconPath);
		if (fs.existsSync(assetsPath)) {
			return assetsPath;
		}

		// Try relative to cwd
		const cwdPath = path.join(process.cwd(), iconPath);
		if (fs.existsSync(cwdPath)) {
			return cwdPath;
		}

		// Return as-is and let Electrobun handle it
		return iconPath;
	}

	private getSession(partition: string) {
		const normalized = partition.trim() || "persist:default";
		if (normalized === "persist:default") {
			return Session.defaultSession;
		}
		return Session.fromPartition(normalized);
	}

	private readSessionSnapshot(partition: string): DesktopSessionSnapshot {
		const session = this.getSession(partition);
		const cookies = session.cookies.get().map((cookie) => ({
			name: cookie.name,
			domain: cookie.domain,
			path: cookie.path,
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			session: (cookie as typeof cookie & { session?: boolean }).session,
			expirationDate: cookie.expirationDate,
		}));

		return {
			partition: session.partition,
			persistent: session.partition.startsWith("persist:"),
			cookieCount: cookies.length,
			cookies,
		};
	}

	private normalizeReleaseNotesUrl(url: string): string {
		const trimmed = url.trim() || DEFAULT_RELEASE_NOTES_URL;
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("Release notes URL must use http or https");
		}
		return parsed.toString();
	}

	private buildReleaseNotesNavigationRules(url: string): string[] {
		const parsed = new URL(url);
		const origin = parsed.origin.replace(/\/+$/, "");
		return [parsed.toString(), `${origin}/*`];
	}

	private async buildUpdaterSnapshot(
		error?: unknown,
		availability = this.getUpdaterAvailability(),
	): Promise<DesktopUpdaterSnapshot> {
		let currentVersion = "unknown";
		let currentHash: string | undefined;
		let channel: string | undefined;
		let baseUrl: string | undefined;
		let snapshotError =
			error instanceof Error ? error.message : error ? String(error) : null;

		try {
			const localInfo = await Updater.getLocallocalInfo();
			currentVersion = localInfo.version;
			currentHash = localInfo.hash;
			channel = localInfo.channel;
			baseUrl = localInfo.baseUrl;
		} catch (localError) {
			if (!snapshotError) {
				snapshotError =
					localError instanceof Error
						? localError.message
						: String(localError ?? "Unknown updater error");
			}
		}

		const updateInfo =
			(Updater.updateInfo?.() as Partial<{
				version: string;
				hash: string;
				updateAvailable: boolean;
				updateReady: boolean;
				error: string;
			}>) ?? {};
		const lastStatusEntry = Updater.getStatusHistory?.().at(-1) ?? null;

		return {
			currentVersion,
			currentHash,
			channel,
			baseUrl,
			appBundlePath: availability.appBundlePath,
			canAutoUpdate: availability.canAutoUpdate,
			autoUpdateDisabledReason: availability.autoUpdateDisabledReason,
			updateAvailable: Boolean(updateInfo.updateAvailable),
			updateReady: Boolean(updateInfo.updateReady),
			latestVersion: updateInfo.version ?? null,
			latestHash: updateInfo.hash ?? null,
			error: updateInfo.error || snapshotError,
			lastStatus: lastStatusEntry
				? {
						status: lastStatusEntry.status,
						message: lastStatusEntry.message,
						timestamp: lastStatusEntry.timestamp,
					}
				: null,
		};
	}

	private getUpdaterAvailability(): {
		appBundlePath: string | null;
		canAutoUpdate: boolean;
		autoUpdateDisabledReason: string | null;
	} {
		if (process.platform !== "darwin") {
			return {
				appBundlePath: null,
				canAutoUpdate: true,
				autoUpdateDisabledReason: null,
			};
		}

		const appBundlePath = this.resolveMacAppBundlePath(process.execPath);
		if (!appBundlePath) {
			return {
				appBundlePath: null,
				canAutoUpdate: false,
				autoUpdateDisabledReason: `${getBrandConfig().appName} must run from an installed .app bundle to enable in-place updates.`,
			};
		}

		const supportedRoots = [
			"/Applications",
			path.join(Utils.paths.home, "Applications"),
		].map((root) => path.resolve(root));
		const normalizedBundlePath = path.resolve(appBundlePath);
		const inApplications = supportedRoots.some((root) => {
			const normalizedRoot = root.endsWith(path.sep)
				? root
				: `${root}${path.sep}`;
			return (
				normalizedBundlePath === root ||
				normalizedBundlePath.startsWith(normalizedRoot)
			);
		});

		if (inApplications) {
			return {
				appBundlePath: normalizedBundlePath,
				canAutoUpdate: true,
				autoUpdateDisabledReason: null,
			};
		}

		return {
			appBundlePath: normalizedBundlePath,
			canAutoUpdate: false,
			autoUpdateDisabledReason: `Move ${path.basename(
				normalizedBundlePath,
			)} to /Applications to enable in-place desktop updates.`,
		};
	}

	private resolveMacAppBundlePath(execPath: string): string | null {
		let current = path.resolve(execPath);
		while (true) {
			if (current.endsWith(".app")) {
				return current;
			}
			const parent = path.dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	}

	private resolvePreferredBrowserRenderer(
		buildInfo: Awaited<ReturnType<typeof BuildConfig.get>>,
	): "native" | "cef" {
		if (
			process.platform === "linux" &&
			buildInfo.availableRenderers.includes("cef")
		) {
			return "cef";
		}

		return buildInfo.defaultRenderer;
	}

	/**
	 * Clean up all resources.
	 */
	dispose(): void {
		if (this._focusPoller) {
			clearInterval(this._focusPoller);
			this._focusPoller = null;
		}
		this.teardownWindowEvents(this.mainWindow);
		this.mainWindow = null;
		this.releaseNotesView?.remove();
		this.releaseNotesView = null;
		this.releaseNotesWindow = null;
		this.unregisterAllShortcuts();
		void this.destroyTray();
		this.trayMenuItems.clear();
		this.sendToWebview = null;
	}
}

// ============================================================================
// Singleton
// ============================================================================

let desktopManager: DesktopManager | null = null;

export function getDesktopManager(): DesktopManager {
	if (!desktopManager) {
		desktopManager = new DesktopManager();
	}
	return desktopManager;
}
