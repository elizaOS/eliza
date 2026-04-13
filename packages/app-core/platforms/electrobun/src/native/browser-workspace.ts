import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserWindow } from "electrobun/bun";
import { getBrandConfig } from "../brand-config";
import type { SendToWebview, WebviewEvalRpc } from "../types.js";

const DEFAULT_TAB_BOUNDS = {
  x: 120,
  y: 90,
  width: 1360,
  height: 920,
} as const;
const HIDDEN_WINDOW_POSITION = -99_999;
const DEFAULT_PARTITION = getBrandConfig().browserWorkspacePartition;

export interface BrowserWorkspaceTabSnapshot {
  id: string;
  title: string;
  url: string;
  partition: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
}

interface BrowserWorkspaceTab extends BrowserWorkspaceTabSnapshot {
  window: BrowserWindow;
  savedPosition: { x: number; y: number } | null;
}

export interface OpenBrowserWorkspaceTabOptions {
  url?: string;
  title?: string;
  show?: boolean;
  partition?: string;
  width?: number;
  height?: number;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function isVisibleWindowPosition(position: { x: number; y: number }): boolean {
  return (
    position.x > HIDDEN_WINDOW_POSITION / 2 &&
    position.y > HIDDEN_WINDOW_POSITION / 2
  );
}

function assertBrowserWorkspaceUrl(url: string): string {
  if (url === "about:blank") {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`browser workspace rejected invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `browser workspace only supports http/https URLs, got ${parsed.protocol}`,
    );
  }

  return parsed.toString();
}

let browserWorkspaceCounter = 0;

export class BrowserWorkspaceManager {
  private sendToWebview: SendToWebview | null = null;
  private readonly tabs = new Map<string, BrowserWorkspaceTab>();

  setSendToWebview(fn: SendToWebview | null): void {
    this.sendToWebview = fn;
  }

  private notify(event: string, payload: Record<string, unknown>): void {
    this.sendToWebview?.("browserWorkspaceEvent", { event, ...payload });
  }

  private toSnapshot(tab: BrowserWorkspaceTab): BrowserWorkspaceTabSnapshot {
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      partition: tab.partition,
      visible: tab.visible,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      lastFocusedAt: tab.lastFocusedAt,
    };
  }

  private getTab(id: string): BrowserWorkspaceTab | null {
    return this.tabs.get(id) ?? null;
  }

  getTabSnapshot(id: string): BrowserWorkspaceTabSnapshot | null {
    const tab = this.getTab(id);
    return tab ? this.toSnapshot(tab) : null;
  }

  async listTabs(): Promise<{ tabs: BrowserWorkspaceTabSnapshot[] }> {
    const tabs = Array.from(this.tabs.values())
      .sort((left, right) => {
        const leftTime = left.lastFocusedAt ?? left.updatedAt;
        const rightTime = right.lastFocusedAt ?? right.updatedAt;
        return (
          rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
        );
      })
      .map((tab) => this.toSnapshot(tab));
    return { tabs };
  }

  async openTab(
    options: OpenBrowserWorkspaceTabOptions = {},
  ): Promise<BrowserWorkspaceTabSnapshot> {
    const visible = options.show === true;
    const url = assertBrowserWorkspaceUrl(options.url ?? "about:blank");
    const title = options.title?.trim() || `${getBrandConfig().appName} Browser`;
    const partition = options.partition?.trim() || DEFAULT_PARTITION;
    const id = `btab_${++browserWorkspaceCounter}`;
    const createdAt = toIsoNow();
    const width = options.width ?? DEFAULT_TAB_BOUNDS.width;
    const height = options.height ?? DEFAULT_TAB_BOUNDS.height;
    const initialX = visible ? DEFAULT_TAB_BOUNDS.x : HIDDEN_WINDOW_POSITION;
    const initialY = visible ? DEFAULT_TAB_BOUNDS.y : HIDDEN_WINDOW_POSITION;

    const win = new BrowserWindow({
      title,
      url,
      frame: {
        x: initialX,
        y: initialY,
        width,
        height,
      },
      transparent: false,
      sandbox: true,
      // @ts-expect-error Electrobun exposes partition at runtime.
      partition,
      ...(process.platform === "darwin" ? { renderer: "native" as const } : {}),
    });

    const tab: BrowserWorkspaceTab = {
      id,
      title,
      url,
      partition,
      visible,
      createdAt,
      updatedAt: createdAt,
      lastFocusedAt: null,
      window: win,
      savedPosition: visible
        ? null
        : { x: DEFAULT_TAB_BOUNDS.x, y: DEFAULT_TAB_BOUNDS.y },
    };

    this.tabs.set(id, tab);

    win.on("focus", () => {
      tab.visible = true;
      tab.lastFocusedAt = toIsoNow();
      tab.updatedAt = tab.lastFocusedAt;
      this.notify("focus", { tab: this.toSnapshot(tab) });
    });

    win.on("close", () => {
      this.tabs.delete(id);
      this.notify("closed", { id });
    });

    this.notify("opened", { tab: this.toSnapshot(tab) });
    return this.toSnapshot(tab);
  }

  async navigateTab(options: {
    id: string;
    url: string;
  }): Promise<BrowserWorkspaceTabSnapshot | null> {
    const tab = this.getTab(options.id);
    if (!tab) return null;

    const nextUrl = assertBrowserWorkspaceUrl(options.url);
    tab.window.webview.loadURL(nextUrl);
    tab.url = nextUrl;
    tab.updatedAt = toIsoNow();
    this.notify("navigated", { tab: this.toSnapshot(tab) });
    return this.toSnapshot(tab);
  }

  async evaluateTab(options: { id: string; script: string }): Promise<unknown> {
    const tab = this.getTab(options.id);
    if (!tab) {
      throw new Error(`browser workspace tab not found: ${options.id}`);
    }

    const rpc = tab.window.webview.rpc as WebviewEvalRpc | undefined;
    return await rpc?.requestProxy?.evaluateJavascriptWithResponse?.({
      script: options.script,
    });
  }

  async snapshotTab(options: { id: string }): Promise<{ data: string } | null> {
    const tab = this.getTab(options.id);
    if (!tab) return null;

    const position = tab.window.getPosition();
    if (!isVisibleWindowPosition(position)) {
      return null;
    }

    let tmpPath: string | undefined;
    try {
      const size = tab.window.getSize();
      const x = position.x ?? 0;
      const y = position.y ?? 0;
      const width = size.width;
      const height = size.height;
      tmpPath = path.join(
        os.tmpdir(),
        `${getBrandConfig().urlScheme}-browser-workspace-${options.id}-${Date.now()}.png`,
      );
      let proc: ReturnType<typeof Bun.spawn>;

      if (process.platform === "darwin") {
        proc = Bun.spawn(
          [
            "screencapture",
            "-x",
            "-R",
            `${x},${y},${width},${height}`,
            "-t",
            "png",
            tmpPath,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      } else if (process.platform === "win32") {
        const psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
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
        proc = Bun.spawn(
          [
            "import",
            "-window",
            "root",
            "-crop",
            `${width}x${height}+${x}+${y}`,
            tmpPath,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      }

      await proc.exited;

      if (!fs.existsSync(tmpPath)) {
        return null;
      }

      const buf = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);
      return buf.length > 100 ? { data: buf.toString("base64") } : null;
    } catch {
      return null;
    } finally {
      // Clean up tmp file if it was created but not yet deleted (e.g. crash
      // between screencapture write and unlinkSync above).
      try {
        if (tmpPath && fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  async showTab(options: {
    id: string;
  }): Promise<BrowserWorkspaceTabSnapshot | null> {
    const tab = this.getTab(options.id);
    if (!tab) return null;

    const restore = tab.savedPosition ?? {
      x: DEFAULT_TAB_BOUNDS.x,
      y: DEFAULT_TAB_BOUNDS.y,
    };
    tab.window.setPosition(restore.x, restore.y);
    tab.window.show();
    tab.window.focus();
    tab.savedPosition = null;
    tab.visible = true;
    tab.lastFocusedAt = toIsoNow();
    tab.updatedAt = tab.lastFocusedAt;
    this.notify("shown", { tab: this.toSnapshot(tab) });
    return this.toSnapshot(tab);
  }

  async hideTab(options: {
    id: string;
  }): Promise<BrowserWorkspaceTabSnapshot | null> {
    const tab = this.getTab(options.id);
    if (!tab) return null;

    if (!tab.savedPosition) {
      const position = tab.window.getPosition();
      tab.savedPosition = {
        x: position.x ?? DEFAULT_TAB_BOUNDS.x,
        y: position.y ?? DEFAULT_TAB_BOUNDS.y,
      };
    }
    tab.window.setPosition(HIDDEN_WINDOW_POSITION, HIDDEN_WINDOW_POSITION);
    tab.visible = false;
    tab.updatedAt = toIsoNow();
    this.notify("hidden", { tab: this.toSnapshot(tab) });
    return this.toSnapshot(tab);
  }

  async closeTab(options: { id: string }): Promise<boolean> {
    const tab = this.getTab(options.id);
    if (!tab) return false;
    try {
      tab.window.close();
    } finally {
      this.tabs.delete(options.id);
    }
    return true;
  }

  dispose(): void {
    for (const tab of this.tabs.values()) {
      try {
        tab.window.close();
      } catch {
        // already closed
      }
    }
    this.tabs.clear();
    this.sendToWebview = null;
  }
}

let browserWorkspaceManager: BrowserWorkspaceManager | null = null;

export function getBrowserWorkspaceManager(): BrowserWorkspaceManager {
  if (!browserWorkspaceManager) {
    browserWorkspaceManager = new BrowserWorkspaceManager();
  }
  return browserWorkspaceManager;
}

export function resetBrowserWorkspaceManagerForTesting(): void {
  browserWorkspaceManager?.dispose();
  browserWorkspaceManager = null;
  browserWorkspaceCounter = 0;
}
