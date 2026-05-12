/**
 * GpuWindow Native Module for Electrobun
 *
 * Manages floating always-on-top companion windows backed by native GPU
 * surfaces (GpuWindow + WGPUView) using Electrobun's bundled Dawn WebGPU.
 *
 * Each GpuWindow automatically gets a full-coverage WGPUView at construction.
 * The renderer can trigger creation/destruction/resize via RPC. The native
 * handle exposed by WGPUView.getNativeHandle() can be passed to a WGPU
 * render loop on the Bun side for CPU→GPU avatar compositing outside the
 * main webview.
 *
 * Lifecycle:
 *   gpuWindowCreate  → creates GpuWindow (always-on-top, transparent)
 *   gpuWindowShow    → focuses/shows the window
 *   gpuWindowHide    → minimizes the window
 *   gpuWindowSetBounds → repositions/resizes and syncs the WGPUView frame
 *   gpuWindowDestroy → closes window and removes WGPUView
 *   gpuWindowGetInfo → returns current id, frame, and wgpuViewId
 *
 * WGPUView (in main window):
 *   gpuViewCreate    → adds a WGPUView to the main BrowserWindow at a given frame
 *   gpuViewSetFrame  → resizes the WGPUView (call when companion area changes)
 *   gpuViewSetTransparent → makes the view background transparent/opaque
 *   gpuViewSetHidden → show/hide without destroying
 *   gpuViewGetNativeHandle → returns the native Metal/D3D12 layer handle
 *   gpuViewDestroy   → removes the WGPUView
 *
 * Push events:
 *   gpuWindowClosed  → fired by the native close event (Bun → webview)
 */

import { GpuWindow, WGPUView } from "electrobun/bun";
import { getBrandConfig } from "../brand-config";
import type { GpuViewInfo, GpuWindowInfo, WindowBounds } from "../rpc-schema";
import type { SendToWebview } from "../types.js";

export class GpuWindowManager {
	private sendToWebview: SendToWebview | null = null;
	private gpuWindows: Map<string, GpuWindow> = new Map();
	private gpuViews: Map<string, WGPUView> = new Map();
	private destroyingWindows: Set<string> = new Set();

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	// --------------------------------------------------------------------------
	// GpuWindow — floating companion window
	// --------------------------------------------------------------------------

	/**
	 * Create a floating GPU-accelerated companion window.
	 * The window is always-on-top and transparent by default so it can float
	 * the avatar above other applications without a background fill.
	 */
	async createWindow(options: {
		id?: string;
		title?: string;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		transparent?: boolean;
		alwaysOnTop?: boolean;
		titleBarStyle?: "hidden" | "hiddenInset" | "default";
	}): Promise<GpuWindowInfo> {
		const id = options.id ?? `gpu_win_${Date.now()}`;

		const existingWin = this.gpuWindows.get(id);
		if (existingWin) {
			return {
				id,
				frame: existingWin.frame,
				wgpuViewId: existingWin.wgpuViewId,
			};
		}

		const win = new GpuWindow({
			title: options.title ?? `${getBrandConfig().appName} Companion`,
			frame: {
				x: options.x ?? 100,
				y: options.y ?? 100,
				width: options.width ?? 400,
				height: options.height ?? 600,
			},
			transparent: options.transparent ?? true,
			titleBarStyle: options.titleBarStyle ?? "hidden",
		});

		if (options.alwaysOnTop !== false) {
			win.setAlwaysOnTop(true);
		}

		this.gpuWindows.set(id, win);

		// Forward close events to the renderer, but only when the window was
		// closed by the user (not programmatically via destroyWindow).
		win.on("close", () => {
			this.gpuWindows.delete(id);
			if (!this.destroyingWindows.has(id)) {
				this.sendToWebview?.("gpuWindowClosed", { id });
			}
		});

		return {
			id,
			frame: win.frame,
			wgpuViewId: win.wgpuViewId,
		};
	}

	async destroyWindow(options: { id: string }): Promise<void> {
		const win = this.gpuWindows.get(options.id);
		if (!win) return;
		// Mark as programmatically destroyed so the close event handler skips
		// firing gpuWindowClosed — the caller already knows it destroyed the window.
		this.destroyingWindows.add(options.id);
		win.close();
		this.gpuWindows.delete(options.id);
		this.destroyingWindows.delete(options.id);
	}

	async showWindow(options: { id: string }): Promise<void> {
		const win = this.gpuWindows.get(options.id);
		if (!win) return;
		win.show();
	}

	async hideWindow(options: { id: string }): Promise<void> {
		const win = this.gpuWindows.get(options.id);
		if (!win) return;
		// GpuWindow.hide() makes the window invisible without sending it to the
		// dock (unlike minimize). Fall back to minimize() if not available yet in
		// this Electrobun build.
		if (typeof (win as GpuWindow & { hide?: () => void }).hide === "function") {
			(win as GpuWindow & { hide: () => void }).hide();
		} else {
			win.minimize();
		}
	}

	async setBounds(options: { id: string } & WindowBounds): Promise<void> {
		const win = this.gpuWindows.get(options.id);
		if (!win) return;
		win.setFrame(options.x, options.y, options.width, options.height);
		// Keep the embedded WGPUView in sync with the window size
		win.wgpuView?.setFrame(0, 0, options.width, options.height);
	}

	async getInfo(options: { id: string }): Promise<GpuWindowInfo | null> {
		const win = this.gpuWindows.get(options.id);
		if (!win) return null;
		return {
			id: options.id,
			frame: win.frame,
			wgpuViewId: win.wgpuViewId,
		};
	}

	async listWindows(): Promise<{ windows: GpuWindowInfo[] }> {
		const windows: GpuWindowInfo[] = [];
		for (const [id, win] of this.gpuWindows.entries()) {
			windows.push({ id, frame: win.frame, wgpuViewId: win.wgpuViewId });
		}
		return { windows };
	}

	// --------------------------------------------------------------------------
	// WGPUView — GPU surface inside an existing BrowserWindow
	// --------------------------------------------------------------------------

	/**
	 * Attach a WGPUView to the main BrowserWindow at the given frame.
	 * This lets the Bun side render GPU content inside the companion UI
	 * area without owning a separate top-level window.
	 */
	async createView(options: {
		id?: string;
		windowId: number;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		autoResize?: boolean;
		transparent?: boolean;
		passthrough?: boolean;
	}): Promise<GpuViewInfo> {
		const id = options.id ?? `gpu_view_${Date.now()}`;

		const existingView = this.gpuViews.get(id);
		if (existingView) {
			return { id, frame: existingView.frame, viewId: existingView.id };
		}

		// Trust boundary: windowId comes from the renderer (a local trusted origin).
		const view = new WGPUView({
			frame: {
				x: options.x ?? 0,
				y: options.y ?? 0,
				width: options.width ?? 400,
				height: options.height ?? 400,
			},
			windowId: options.windowId,
			autoResize: options.autoResize ?? false,
			startTransparent: options.transparent ?? false,
			startPassthrough: options.passthrough ?? false,
		});

		this.gpuViews.set(id, view);

		return {
			id,
			frame: view.frame,
			viewId: view.id,
		};
	}

	async setViewFrame(options: { id: string } & WindowBounds): Promise<void> {
		const view = this.gpuViews.get(options.id);
		if (!view) return;
		view.setFrame(options.x, options.y, options.width, options.height);
	}

	async setViewTransparent(options: {
		id: string;
		transparent: boolean;
	}): Promise<void> {
		const view = this.gpuViews.get(options.id);
		if (!view) return;
		view.setTransparent(options.transparent);
	}

	async setViewHidden(options: { id: string; hidden: boolean }): Promise<void> {
		const view = this.gpuViews.get(options.id);
		if (!view) return;
		view.setHidden(options.hidden);
	}

	async getViewNativeHandle(options: {
		id: string;
	}): Promise<{ handle: unknown } | null> {
		const view = this.gpuViews.get(options.id);
		if (!view) return null;
		// Safety: returning a raw native handle to the renderer is acceptable because
		// the renderer is a trusted local-origin webview, not an external site.
		const handle = view.getNativeHandle();
		return { handle };
	}

	async destroyView(options: { id: string }): Promise<void> {
		const view = this.gpuViews.get(options.id);
		if (!view) return;
		view.remove();
		this.gpuViews.delete(options.id);
	}

	async listViews(): Promise<{ views: GpuViewInfo[] }> {
		const views: GpuViewInfo[] = [];
		for (const [id, view] of this.gpuViews.entries()) {
			views.push({ id, frame: view.frame, viewId: view.id });
		}
		return { views };
	}

	// --------------------------------------------------------------------------
	// Lifecycle
	// --------------------------------------------------------------------------

	dispose(): void {
		for (const [id, win] of this.gpuWindows.entries()) {
			this.destroyingWindows.add(id);
			try {
				win.close();
			} catch {
				// ignore — window may already be closed
			}
		}
		this.gpuWindows.clear();
		this.destroyingWindows.clear();

		for (const [, view] of this.gpuViews.entries()) {
			try {
				view.remove();
			} catch {
				// ignore
			}
		}
		this.gpuViews.clear();
	}
}

// Singleton instance
let gpuWindowManager: GpuWindowManager | null = null;

export function getGpuWindowManager(): GpuWindowManager {
	if (!gpuWindowManager) {
		gpuWindowManager = new GpuWindowManager();
	}
	return gpuWindowManager;
}
