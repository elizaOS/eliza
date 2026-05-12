/**
 * Canvas Native Module for Electrobun
 *
 * Creates auxiliary BrowserWindow instances for web navigation,
 * script execution, and popout windows (A2UI, embeds, etc.).
 *
 * Uses Electrobun's BrowserWindow + BrowserView for each canvas window.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow } from "electrobun/bun";
import { createElectrobunBrowserWindow } from "../electrobun-window-options";
import type {
	CanvasWindowInfo,
	CanvasWindowOptions,
	WindowBounds,
} from "../rpc-schema";
import type { SendToWebview, WebviewEvalRpc } from "../types.js";

/**
 * Returns true only for local canvas origins.
 * Uses URL parsing to prevent bypass via `http://localhost.evil.com` etc.
 */
function isLocalCanvasOrigin(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

/**
 * Returns true only for URLs that are safe for privileged canvas eval.
 * Only permits localhost/127.0.0.1 web content and blank initialization
 * pages. file:// URLs are rejected to prevent local filesystem access.
 * It does not rely on prefix matching.
 */
function isInternalCanvasEvalUrl(url: string): boolean {
	if (url === "" || url === "about:blank") {
		return true;
	}

	try {
		const parsed = new URL(url);
		return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

interface CanvasWindow {
	id: string;
	window: BrowserWindow;
	url: string;
	title: string;
	/** Position saved before hide() so show() can restore it. null = not hidden. */
	savedPosition: { x: number; y: number } | null;
}

let canvasCounter = 0;

export class CanvasManager {
	private sendToWebview: SendToWebview | null = null;
	private windows: Map<string, CanvasWindow> = new Map();

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	async createWindow(options: CanvasWindowOptions): Promise<{ id: string }> {
		const id = `canvas_${++canvasCounter}`;

		const win = createElectrobunBrowserWindow({
			title: options.title ?? "Canvas",
			url: options.url ?? null,
			frame: {
				x: options.x ?? 100,
				y: options.y ?? 100,
				width: options.width ?? 800,
				height: options.height ?? 600,
			},
			transparent: options.transparent ?? false,
			sandbox: true,
			partition: "canvas-isolated",
		});
		if (options.alwaysOnTop === true) {
			win.setAlwaysOnTop(true);
		}

		const canvas: CanvasWindow = {
			id,
			window: win,
			url: options.url ?? "",
			title: options.title ?? "Canvas",
			savedPosition: null,
		};

		this.windows.set(id, canvas);

		win.on("close", () => {
			this.windows.delete(id);
			this.sendToWebview?.("canvasWindowEvent", {
				windowId: id,
				event: "closed",
			});
		});

		win.on("focus", () => {
			this.sendToWebview?.("canvasWindowEvent", {
				windowId: id,
				event: "focus",
			});
		});

		return { id };
	}

	async destroyWindow(options: { id: string }): Promise<void> {
		const canvas = this.windows.get(options.id);
		if (canvas) {
			canvas.window.close();
			this.windows.delete(options.id);
		}
	}

	async navigate(options: {
		id: string;
		url: string;
	}): Promise<{ available: boolean; reason?: string }> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return { available: false, reason: "window_not_found" };

		const url = options.url ?? "";
		// Validate URL scheme and host before loading to prevent open redirect
		// to arbitrary external origins.
		let allowed = false;
		try {
			const parsed = new URL(url);
			// data: URLs are excluded: the bridge preload is injected into every
			// canvas window, so a data: page would receive the preload script and
			// could spoof RPC messages. Only local-origin URLs are permitted.
			allowed = isLocalCanvasOrigin(url) || parsed.protocol === "file:";
		} catch {
			allowed = false;
		}

		if (!allowed) {
			console.warn(`[Canvas] Blocked navigation to disallowed URL: ${url}`);
			return { available: false, reason: "url_not_allowed" };
		}

		canvas.window.webview.loadURL(url);
		canvas.url = url;
		return { available: true };
	}

	/**
	 * PRIVILEGED: Executes arbitrary JavaScript in a canvas BrowserWindow
	 * via evaluateJavascriptWithResponse. This is intentionally unrestricted
	 * for agent computer-use capabilities. Security relies on:
	 *   1. Canvas windows being isolated from user-facing content
	 *   2. URL allowlist check below (localhost/file/blank only)
	 * Any XSS in the main webview could invoke this on canvas windows.
	 */
	async eval(options: { id: string; script: string }): Promise<unknown> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return null;

		// Security: only allow eval on local/internal canvas URLs.
		// Uses URL parsing (not startsWith) to prevent bypasses like
		// http://localhost.evil.com or http://localhost@external.com.
		const currentUrl = canvas.window.webview?.url ?? "";
		if (!isInternalCanvasEvalUrl(currentUrl)) {
			throw new Error(
				`canvas:eval blocked — canvas ${options.id} has external URL: ${currentUrl}`,
			);
		}

		try {
			const evalRpc = canvas.window.webview.rpc as WebviewEvalRpc;
			return await evalRpc?.requestProxy?.evaluateJavascriptWithResponse?.({
				script: options.script,
			});
		} catch (err) {
			console.error(`[Canvas] eval error in ${options.id}:`, err);
			return null;
		}
	}

	async snapshot(options: {
		id: string;
		format?: string;
		quality?: number;
	}): Promise<{ data: string } | null> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return null;

		try {
			const pos = canvas.window.getPosition();
			const size = canvas.window.getSize();
			const x = pos.x ?? 0;
			const y = pos.y ?? 0;
			const w = size.width;
			const h = size.height;

			// Skip if window is hidden off-screen (see hide() which uses -99999)
			if (x < -1000 || y < -1000) return null;

			const tmpPath = path.join(
				os.tmpdir(),
				`eliza-canvas-snapshot-${Date.now()}.png`,
			);
			let proc: ReturnType<typeof Bun.spawn>;

			if (process.platform === "darwin") {
				proc = Bun.spawn(
					[
						"screencapture",
						"-x",
						"-R",
						`${x},${y},${w},${h}`,
						"-t",
						"png",
						tmpPath,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
			} else if (process.platform === "win32") {
				// Windows: use PowerShell with .NET to capture a screen region
				const psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$gfx.Dispose()
$bmp.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`;
				proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psScript], {
					stdout: "pipe",
					stderr: "pipe",
				});
			} else {
				// Linux: ImageMagick `import` with root window crop
				proc = Bun.spawn(
					[
						"import",
						"-window",
						"root",
						"-crop",
						`${w}x${h}+${x}+${y}`,
						tmpPath,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
			}

			await proc.exited;

			if (!fs.existsSync(tmpPath)) return null;
			const buf = fs.readFileSync(tmpPath);
			fs.unlinkSync(tmpPath);

			if (buf.length < 100) return null; // empty or failed capture

			return { data: buf.toString("base64") };
		} catch {
			return null;
		}
	}

	async a2uiPush(options: { id: string; payload: unknown }): Promise<void> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return;

		const script = `
      if (window.elizaDesktopUI && typeof window.elizaDesktopUI.push === 'function') {
        window.elizaDesktopUI.push(${JSON.stringify(options.payload)});
      }
    `;
		try {
			const pushRpc = canvas.window.webview.rpc as WebviewEvalRpc;
			await pushRpc?.requestProxy?.evaluateJavascriptWithResponse?.({ script });
		} catch {
			// Window may have been destroyed
		}
	}

	async a2uiReset(options: { id: string }): Promise<void> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return;

		const script = `
      if (window.elizaDesktopUI && typeof window.elizaDesktopUI.reset === 'function') {
        window.elizaDesktopUI.reset();
      }
    `;
		try {
			const resetRpc = canvas.window.webview.rpc as WebviewEvalRpc;
			await resetRpc?.requestProxy?.evaluateJavascriptWithResponse?.({
				script,
			});
		} catch {
			// Window may have been destroyed
		}
	}

	async show(options: { id: string }): Promise<void> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return;
		// Restore saved position before making visible so the window isn't
		// stuck at the off-screen coordinates set by hide().
		if (canvas.savedPosition) {
			canvas.window.setPosition(canvas.savedPosition.x, canvas.savedPosition.y);
			canvas.savedPosition = null;
		}
		canvas.window.show();
	}

	async hide(options: { id: string }): Promise<void> {
		// Electrobun has no hide() API — move off-screen so the window
		// disappears without showing a dock bounce or taskbar entry.
		const canvas = this.windows.get(options.id);
		if (!canvas) return;
		// Save position so show() can restore it.
		const pos = canvas.window.getPosition();
		canvas.savedPosition = { x: pos.x, y: pos.y };
		canvas.window.setPosition(-99999, -99999);
	}

	async resize(options: {
		id: string;
		width: number;
		height: number;
	}): Promise<void> {
		this.windows.get(options.id)?.window.setSize(options.width, options.height);
	}

	async focus(options: { id: string }): Promise<void> {
		this.windows.get(options.id)?.window.focus();
	}

	async getBounds(options: { id: string }): Promise<WindowBounds> {
		const win = this.windows.get(options.id)?.window;
		if (!win) return { x: 0, y: 0, width: 0, height: 0 };
		const pos = win.getPosition();
		const size = win.getSize();
		return { x: pos.x, y: pos.y, width: size.width, height: size.height };
	}

	async setBounds(options: { id: string } & WindowBounds): Promise<void> {
		const win = this.windows.get(options.id)?.window;
		if (!win) return;
		win.setPosition(options.x, options.y);
		win.setSize(options.width, options.height);
	}

	async setAlwaysOnTop(options: {
		id: string;
		flag: boolean;
	}): Promise<{ success: boolean }> {
		const canvas = this.windows.get(options.id);
		if (!canvas) return { success: false };
		canvas.window.setAlwaysOnTop(options.flag);
		return { success: true };
	}

	/**
	 * Opens a game client URL in a dedicated isolated BrowserWindow.
	 *
	 * Unlike createWindow(), this does NOT enforce a localhost-only navigation
	 * rule because game clients (Hyperscape, 2004scape) are external origins.
	 * The window uses its own "game-isolated" session partition so cookies and
	 * storage are separated from the main renderer and canvas windows.
	 *
	 * canvasEval() is intentionally NOT available on game windows — they are
	 * opened for display/interaction only, not agent computer-use.
	 *
	 * Security: only http: and https: are permitted. file:, javascript:, data:,
	 * and other schemes are blocked to prevent local file access and code injection.
	 */
	async openGameWindow(options: {
		url: string;
		title?: string;
		alwaysOnTop?: boolean;
	}): Promise<{ id: string }> {
		// Validate protocol before passing the URL to the native layer.
		// file: would grant access to local filesystem; javascript:/data: could inject code.
		try {
			const parsed = new URL(options.url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(
					`openGameWindow blocked — only http/https URLs are permitted, got: ${parsed.protocol}`,
				);
			}
		} catch (err) {
			if (err instanceof TypeError) {
				throw new Error(`openGameWindow blocked — invalid URL: ${options.url}`);
			}
			throw err;
		}

		const id = `game_${++canvasCounter}`;

		// On macOS, force the native WKWebView renderer which has built-in
		// WebGPU support (macOS 26+). On Linux/Windows, CEF is the only option
		// and will need upstream Electrobun support for --enable-unsafe-webgpu.
		const useNativeRenderer = process.platform === "darwin";
		if (!useNativeRenderer) {
			console.warn(
				"[Canvas] Game window using CEF renderer — WebGPU may not be available. " +
					"Upstream Electrobun support for CEF WebGPU flags is pending.",
			);
		}

		const win = createElectrobunBrowserWindow({
			title: options.title ?? "Game",
			url: options.url,
			frame: {
				x: 100,
				y: 100,
				width: 1024,
				height: 768,
			},
			transparent: false,
			sandbox: true,
			partition: "game-isolated",
			// On macOS, use the native WKWebView renderer for WebGPU support.
			// On Linux/Win, omit this to use the default CEF renderer.
			...(useNativeRenderer ? { renderer: "native" as const } : {}),
			// No navigationRules restriction — game sites navigate externally.
		});
		if (options.alwaysOnTop === true) {
			win.setAlwaysOnTop(true);
		}

		const canvas: CanvasWindow = {
			id,
			window: win,
			url: options.url,
			title: options.title ?? "Game",
			savedPosition: null,
		};

		this.windows.set(id, canvas);

		win.on("close", () => {
			this.windows.delete(id);
			this.sendToWebview?.("canvasWindowEvent", {
				windowId: id,
				event: "closed",
			});
		});

		win.on("focus", () => {
			this.sendToWebview?.("canvasWindowEvent", {
				windowId: id,
				event: "focus",
			});
		});

		return { id };
	}

	async listWindows(): Promise<{ windows: CanvasWindowInfo[] }> {
		const result: CanvasWindowInfo[] = [];
		for (const [id, canvas] of this.windows) {
			const pos = canvas.window.getPosition();
			const size = canvas.window.getSize();
			result.push({
				id,
				url: canvas.url,
				bounds: { x: pos.x, y: pos.y, width: size.width, height: size.height },
				title: canvas.title,
				alwaysOnTop: canvas.window.isAlwaysOnTop(),
			});
		}
		return { windows: result };
	}

	dispose(): void {
		for (const canvas of this.windows.values()) {
			try {
				canvas.window.close();
			} catch {
				// Already destroyed
			}
		}
		this.windows.clear();
		this.sendToWebview = null;
	}
}

let canvasManager: CanvasManager | null = null;

export function getCanvasManager(): CanvasManager {
	if (!canvasManager) {
		canvasManager = new CanvasManager();
	}
	return canvasManager;
}
