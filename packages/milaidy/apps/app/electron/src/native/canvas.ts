/**
 * Canvas Native Module for Electron
 *
 * Provides a BrowserWindow-based "canvas" for web navigation, JS evaluation,
 * page snapshots, and A2UI message injection.  Each canvas is a separate
 * BrowserWindow (not the main app window).
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import type { IpcMainInvokeEvent, Rectangle } from "electron";
import type { IpcValue } from "./ipc-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CanvasWindowOptions {
  url?: string;
  width?: number;
  height?: number;
  show?: boolean;
  title?: string;
  x?: number;
  y?: number;
  /** Allow the window's page to open dev tools on creation (dev-only). */
  devTools?: boolean;
}

export interface CanvasSnapshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
  /** Capture only a sub-rectangle (in CSS pixels). */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface CanvasSnapshotResult {
  base64: string;
  format: string;
  width: number;
  height: number;
}

export interface CanvasWindowInfo {
  id: string;
  url: string;
  title: string;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface CanvasResizeOptions {
  width: number;
  height: number;
  animate?: boolean;
}

export interface A2UIPayload {
  type: string;
  [key: string]: unknown;
}

// ── Manager ─────────────────────────────────────────────────────────────────

/**
 * Canvas Manager – creates / controls one or more auxiliary BrowserWindows.
 */
export class CanvasManager {
  private mainWindow: BrowserWindow | null = null;
  private windows: Map<string, BrowserWindow> = new Map();
  private counter = 0;

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  // ── Window lifecycle ────────────────────────────────────────────────────

  private getWindow(id: string): BrowserWindow {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) {
      throw new Error(`Canvas window "${id}" not found or destroyed`);
    }
    return win;
  }

  /** Create a new canvas BrowserWindow and return its id. */
  async createWindow(options?: CanvasWindowOptions): Promise<{ windowId: string }> {
    const id = `canvas_${++this.counter}`;
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

    const win = new BrowserWindow({
      width: options?.width ?? 1280,
      height: options?.height ?? 720,
      x: options?.x,
      y: options?.y,
      show: options?.show ?? false,
      title: options?.title ?? "Canvas",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        javascript: true,
      },
    });

    // Forward page-level events to the main renderer so the plugin layer can
    // surface them as Capacitor listeners.
    win.webContents.on("did-finish-load", () => {
      this.sendToRenderer("canvas:didFinishLoad", {
        windowId: id,
        url: win.webContents.getURL(),
      });
    });
    win.webContents.on("did-fail-load", (_ev, code, desc) => {
      this.sendToRenderer("canvas:didFailLoad", {
        windowId: id,
        errorCode: code,
        errorDescription: desc,
      });
    });
    win.on("closed", () => {
      this.windows.delete(id);
      this.sendToRenderer("canvas:windowClosed", { windowId: id });
    });

    this.windows.set(id, win);

    if (options?.url) {
      await win.loadURL(options.url);
    }

    return { windowId: id };
  }

  /** Close and dispose a canvas window. */
  async destroyWindow(options: { windowId: string }): Promise<void> {
    const win = this.getWindow(options.windowId);
    win.close();
    this.windows.delete(options.windowId);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Navigate the canvas window to a URL. */
  async navigate(options: { windowId: string; url: string }): Promise<void> {
    const win = this.getWindow(options.windowId);
    await win.loadURL(options.url);
  }

  // ── JavaScript evaluation ───────────────────────────────────────────────

  /** Execute arbitrary JavaScript in the canvas page and return the result. */
  async eval(options: { windowId: string; script: string }): Promise<{ result: unknown }> {
    const win = this.getWindow(options.windowId);
    const result = await win.webContents.executeJavaScript(options.script, true);
    return { result };
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /** Capture a screenshot of the canvas page. */
  async snapshot(options: { windowId: string } & CanvasSnapshotOptions): Promise<CanvasSnapshotResult> {
    const win = this.getWindow(options.windowId);
    const rect: Rectangle | undefined = options.rect
      ? { x: options.rect.x, y: options.rect.y, width: options.rect.width, height: options.rect.height }
      : undefined;

    const image = await win.webContents.capturePage(rect);
    const format = options.format ?? "png";
    const size = image.getSize();

    let base64: string;
    if (format === "jpeg") {
      base64 = image.toJPEG(options.quality ?? 90).toString("base64");
    } else {
      base64 = image.toPNG().toString("base64");
    }

    return { base64, format, width: size.width, height: size.height };
  }

  // ── A2UI ────────────────────────────────────────────────────────────────

  /** Inject an A2UI message payload into the canvas page. */
  async a2uiPush(options: { windowId: string; payload: A2UIPayload }): Promise<void> {
    const win = this.getWindow(options.windowId);
    const json = JSON.stringify(options.payload);
    await win.webContents.executeJavaScript(
      `if (window.milaidyA2UI && typeof window.milaidyA2UI.push === 'function') { window.milaidyA2UI.push(${json}); }`,
    );
  }

  /** Reset the A2UI state on the canvas page. */
  async a2uiReset(options: { windowId: string }): Promise<void> {
    const win = this.getWindow(options.windowId);
    await win.webContents.executeJavaScript(
      `if (window.milaidyA2UI && typeof window.milaidyA2UI.reset === 'function') { window.milaidyA2UI.reset(); }`,
    );
  }

  // ── Visibility / geometry ───────────────────────────────────────────────

  async show(options: { windowId: string }): Promise<void> {
    this.getWindow(options.windowId).show();
  }

  async hide(options: { windowId: string }): Promise<void> {
    this.getWindow(options.windowId).hide();
  }

  async resize(options: { windowId: string } & CanvasResizeOptions): Promise<void> {
    const win = this.getWindow(options.windowId);
    win.setSize(options.width, options.height, options.animate);
  }

  async focus(options: { windowId: string }): Promise<void> {
    this.getWindow(options.windowId).focus();
  }

  async getBounds(options: { windowId: string }): Promise<{ bounds: { x: number; y: number; width: number; height: number } }> {
    return { bounds: this.getWindow(options.windowId).getBounds() };
  }

  async setBounds(options: { windowId: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<void> {
    this.getWindow(options.windowId).setBounds(options.bounds);
  }

  // ── Query ───────────────────────────────────────────────────────────────

  async listWindows(): Promise<{ windows: CanvasWindowInfo[] }> {
    const list: CanvasWindowInfo[] = [];
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      list.push({
        id,
        url: win.webContents.getURL(),
        title: win.getTitle(),
        visible: win.isVisible(),
        bounds: win.getBounds(),
      });
    }
    return { windows: list };
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  dispose(): void {
    for (const [id, win] of this.windows) {
      if (!win.isDestroyed()) win.close();
    }
    this.windows.clear();
  }

  private sendToRenderer(channel: string, data?: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

// ── Singleton & IPC ─────────────────────────────────────────────────────────

let canvasManager: CanvasManager | null = null;

export function getCanvasManager(): CanvasManager {
  if (!canvasManager) {
    canvasManager = new CanvasManager();
  }
  return canvasManager;
}

export function registerCanvasIPC(): void {
  const m = getCanvasManager();

  // Lifecycle
  ipcMain.handle("canvas:createWindow", async (_e: IpcMainInvokeEvent, opts?: CanvasWindowOptions) => m.createWindow(opts));
  ipcMain.handle("canvas:destroyWindow", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.destroyWindow(opts));

  // Navigation / eval
  ipcMain.handle("canvas:navigate", async (_e: IpcMainInvokeEvent, opts: { windowId: string; url: string }) => m.navigate(opts));
  ipcMain.handle("canvas:eval", async (_e: IpcMainInvokeEvent, opts: { windowId: string; script: string }) => m.eval(opts));

  // Snapshot
  ipcMain.handle("canvas:snapshot", async (_e: IpcMainInvokeEvent, opts: { windowId: string } & CanvasSnapshotOptions) => m.snapshot(opts));

  // A2UI
  ipcMain.handle("canvas:a2uiPush", async (_e: IpcMainInvokeEvent, opts: { windowId: string; payload: A2UIPayload }) => m.a2uiPush(opts));
  ipcMain.handle("canvas:a2uiReset", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.a2uiReset(opts));

  // Visibility / geometry
  ipcMain.handle("canvas:show", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.show(opts));
  ipcMain.handle("canvas:hide", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.hide(opts));
  ipcMain.handle("canvas:resize", async (_e: IpcMainInvokeEvent, opts: { windowId: string } & CanvasResizeOptions) => m.resize(opts));
  ipcMain.handle("canvas:focus", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.focus(opts));
  ipcMain.handle("canvas:getBounds", async (_e: IpcMainInvokeEvent, opts: { windowId: string }) => m.getBounds(opts));
  ipcMain.handle("canvas:setBounds", async (_e: IpcMainInvokeEvent, opts: { windowId: string; bounds: { x: number; y: number; width: number; height: number } }) => m.setBounds(opts));

  // Query
  ipcMain.handle("canvas:listWindows", async () => m.listWindows());
}
