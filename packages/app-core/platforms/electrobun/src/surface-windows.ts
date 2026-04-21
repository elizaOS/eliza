import { getBrandConfig } from "./brand-config";

export type DetachedSurface =
  | "chat"
  | "browser"
  | "release"
  | "triggers"
  | "plugins"
  | "connectors"
  | "cloud";
export type ManagedSurface = DetachedSurface | "settings";

export interface ManagedWindowSnapshot {
  id: string;
  surface: ManagedSurface;
  title: string;
  singleton: boolean;
}

export interface ManagedWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManagedWindowLike {
  focus(): void;
  on(event: "close" | "focus", handler: () => void): void;
  webview: {
    on(event: "dom-ready", handler: () => void): void;
    toggleDevTools?: () => void;
    openDevTools?: () => void;
  };
}

export interface CreateManagedWindowOptions {
  title: string;
  url: string;
  preload: string;
  frame: ManagedWindowFrame;
  titleBarStyle: "default";
  transparent: boolean;
}

interface ManagedWindowRecord extends ManagedWindowSnapshot {
  window: ManagedWindowLike;
}

interface SurfaceWindowManagerOptions {
  createWindow: (options: CreateManagedWindowOptions) => ManagedWindowLike;
  resolveRendererUrl: () => Promise<string>;
  readPreload: () => string;
  wireRpc: (window: ManagedWindowLike) => void;
  injectApiBase: (window: ManagedWindowLike) => void;
  onWindowFocused?: (window: ManagedWindowLike) => void;
  onRegistryChanged?: () => void;
}

const SURFACE_LABELS: Record<ManagedSurface, string> = {
  chat: "Chat",
  browser: "Browser",
  release: "Release Center",
  triggers: "Heartbeats",
  plugins: "Plugins",
  connectors: "Connectors",
  cloud: "Cloud",
  settings: "Settings",
};

const SURFACE_FRAMES: Record<ManagedSurface, ManagedWindowFrame> = {
  chat: { x: 120, y: 110, width: 1180, height: 840 },
  browser: { x: 140, y: 100, width: 1320, height: 900 },
  release: { x: 160, y: 100, width: 1260, height: 920 },
  triggers: { x: 160, y: 140, width: 1080, height: 780 },
  plugins: { x: 180, y: 160, width: 1180, height: 860 },
  connectors: { x: 200, y: 180, width: 1180, height: 860 },
  cloud: { x: 220, y: 140, width: 1280, height: 900 },
  settings: { x: 180, y: 120, width: 1240, height: 900 },
};

export function isDetachedSurface(value: string): value is DetachedSurface {
  return (
    value === "chat" ||
    value === "browser" ||
    value === "release" ||
    value === "triggers" ||
    value === "plugins" ||
    value === "connectors" ||
    value === "cloud"
  );
}

function isManagedSurface(value: string): value is ManagedSurface {
  return value === "settings" || isDetachedSurface(value);
}

function ordinalTitle(surface: ManagedSurface, ordinal: number): string {
  // Cloud windows reference "Eliza Cloud" (the service), not the app brand.
  const base =
    surface === "cloud"
      ? "Eliza Cloud"
      : `${getBrandConfig().appName} ${SURFACE_LABELS[surface]}`;
  return ordinal <= 1 ? base : `${base} ${ordinal}`;
}

function normalizeSettingsTabHint(tabHint?: string): string | undefined {
  if (!tabHint) return undefined;
  return tabHint.replace(/^open-settings-/, "") || undefined;
}

export function buildSurfaceShellQuery(
  surface: ManagedSurface,
  tabHint?: string,
  browse?: string,
): string {
  if (surface === "settings") {
    const normalizedTab = normalizeSettingsTabHint(tabHint);
    return normalizedTab
      ? `?shell=settings&tab=${encodeURIComponent(normalizedTab)}`
      : "?shell=settings";
  }
  const base = `?shell=surface&tab=${encodeURIComponent(surface)}`;
  if (surface === "browser" && browse?.trim()) {
    return `${base}&browse=${encodeURIComponent(browse.trim())}`;
  }
  return base;
}

export class SurfaceWindowManager {
  private readonly createWindowFn: SurfaceWindowManagerOptions["createWindow"];
  private readonly resolveRendererUrlFn: SurfaceWindowManagerOptions["resolveRendererUrl"];
  private readonly readPreloadFn: SurfaceWindowManagerOptions["readPreload"];
  private readonly wireRpcFn: SurfaceWindowManagerOptions["wireRpc"];
  private readonly injectApiBaseFn: SurfaceWindowManagerOptions["injectApiBase"];
  private readonly onWindowFocused?: SurfaceWindowManagerOptions["onWindowFocused"];
  private readonly onRegistryChanged?: SurfaceWindowManagerOptions["onRegistryChanged"];
  private readonly windows = new Map<string, ManagedWindowRecord>();
  private counter = 0;

  constructor(options: SurfaceWindowManagerOptions) {
    this.createWindowFn = options.createWindow;
    this.resolveRendererUrlFn = options.resolveRendererUrl;
    this.readPreloadFn = options.readPreload;
    this.wireRpcFn = options.wireRpc;
    this.injectApiBaseFn = options.injectApiBase;
    this.onWindowFocused = options.onWindowFocused;
    this.onRegistryChanged = options.onRegistryChanged;
  }

  listWindows(surface?: ManagedSurface): ManagedWindowSnapshot[] {
    const windows = Array.from(this.windows.values())
      .filter((entry) => (surface ? entry.surface === surface : true))
      .map(({ id, surface: entrySurface, title, singleton }) => ({
        id,
        surface: entrySurface,
        title,
        singleton,
      }));

    return windows.sort((left, right) => {
      if (left.surface === right.surface) {
        return left.title.localeCompare(right.title);
      }
      return left.surface.localeCompare(right.surface);
    });
  }

  async openSettingsWindow(tabHint?: string): Promise<ManagedWindowSnapshot> {
    const existing = Array.from(this.windows.values()).find(
      (entry) => entry.surface === "settings",
    );
    if (existing) {
      existing.window.focus();
      return this.toSnapshot(existing);
    }
    return this.createManagedWindow("settings", tabHint, true);
  }

  async openSurfaceWindow(
    surface: DetachedSurface,
    browse?: string,
  ): Promise<ManagedWindowSnapshot> {
    const seed = surface === "browser" ? browse : undefined;
    return this.createManagedWindow(surface, undefined, false, seed);
  }

  focusWindow(id: string): boolean {
    const existing = this.windows.get(id);
    if (!existing) return false;
    existing.window.focus();
    this.notifyRegistryChanged();
    return true;
  }

  /**
   * Invoke `fn` for every open managed window (settings + detached surfaces).
   * WHY: when the embedded API port changes, `injectApiBase` must reach each
   * webview—not only `BrowserWindow`—so RPC and `fetch` targets stay consistent.
   */
  forEachWindow(fn: (window: ManagedWindowLike) => void): void {
    for (const { window } of this.windows.values()) {
      fn(window);
    }
  }

  private toSnapshot(entry: ManagedWindowRecord): ManagedWindowSnapshot {
    return {
      id: entry.id,
      surface: entry.surface,
      title: entry.title,
      singleton: entry.singleton,
    };
  }

  private async createManagedWindow(
    surface: ManagedSurface,
    tabHint: string | undefined,
    singleton: boolean,
    browse?: string,
  ): Promise<ManagedWindowSnapshot> {
    if (!isManagedSurface(surface)) {
      throw new Error(`Unsupported surface: ${surface}`);
    }

    const rendererUrl = await this.resolveRendererUrlFn();
    const preload = this.readPreloadFn();
    const existingCount = this.listWindows(surface).length;
    const title = singleton
      ? ordinalTitle(surface, 1)
      : ordinalTitle(surface, existingCount + 1);
    const query = buildSurfaceShellQuery(surface, tabHint, browse);
    const id = `${surface}_${++this.counter}`;

    const window = this.createWindowFn({
      title,
      url: `${rendererUrl}${query}`,
      preload,
      frame: SURFACE_FRAMES[surface],
      titleBarStyle: "default",
      transparent: false,
    });

    const record: ManagedWindowRecord = {
      id,
      surface,
      title,
      singleton,
      window,
    };

    this.windows.set(id, record);
    this.wireRpcFn(window);
    this.onWindowFocused?.(window);
    window.webview.on("dom-ready", () => {
      this.injectApiBaseFn(window);
    });
    window.on("close", () => {
      this.windows.delete(id);
      this.notifyRegistryChanged();
    });
    window.on("focus", () => {
      this.onWindowFocused?.(window);
      this.notifyRegistryChanged();
    });
    this.notifyRegistryChanged();
    return this.toSnapshot(record);
  }

  private notifyRegistryChanged(): void {
    this.onRegistryChanged?.();
  }
}
