/**
 * Public API of the `ElizaSurfaceManager` Capacitor plugin (#15245): the native
 * bridge that layers one isolated web surface per Browser tab on the mobile
 * shell. The renderer never imports this package directly — `@elizaos/ui`'s
 * `capacitor-native-surface-shell.ts` models the same method set structurally
 * and calls it through the Capacitor `Plugins` registry — but the shapes here
 * are the source of truth for both native implementations (iOS `WKWebView` on a
 * dedicated `WKProcessPool` + `WKWebsiteDataStore`; Android out-of-process
 * `WebView` + androidx.webkit `Profile`).
 *
 * The load-bearing invariant every method upholds: an independent surface always
 * carries an EXPLICIT process + storage policy. `createSurface` rejects when
 * either field is absent — there is no implicit platform default, because a
 * defaulted storage partition is exactly the cross-surface leak the isolation
 * epic closes.
 */

/** Renderer-process sharing for a surface — its own process, or a shared pool. */
export type SurfaceProcessSharing = "isolated" | "shared";

/** Website-data-store sharing for a surface — its own store, or the host's. */
export type SurfaceStorageSharing = "isolated" | "shared";

export interface CreateSurfaceOptions {
  /** Stable per-surface id (the Browser tab's surface id). */
  id: string;
  /** Initial URL to load, when known. */
  url?: string;
  /** Explicit renderer-process policy. Required — no default. */
  process: SurfaceProcessSharing;
  /** Explicit storage policy. Required — no default. */
  storage: SurfaceStorageSharing;
}

export interface SetBoundsOptions {
  id: string;
  /** Rect in host CSS pixels; the native side scales by the display density. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavigateOptions {
  id: string;
  url: string;
}

export interface SurfaceIdOptions {
  id: string;
}

/** Debug/test introspection of a single surface's live state. */
export interface SurfaceState {
  exists: boolean;
  foregrounded: boolean;
  currentUrl: string | null;
  process: SurfaceProcessSharing | null;
  storage: SurfaceStorageSharing | null;
}

export interface ElizaSurfaceManagerPlugin {
  /**
   * Create a native web surface with the given EXPLICIT process/storage policy.
   * Rejects when `process` or `storage` is missing, or when the platform cannot
   * honour the requested isolation (e.g. Android without multi-profile support).
   */
  createSurface(options: CreateSurfaceOptions): Promise<void>;
  /** Position a surface over the host webview, in host CSS pixels. */
  setBounds(options: SetBoundsOptions): Promise<void>;
  /** Load a URL in an existing surface. */
  navigate(options: NavigateOptions): Promise<void>;
  /** Bring a surface to the front, above the host. */
  foregroundSurface(options: SurfaceIdOptions): Promise<void>;
  /** Keep a surface alive but move it behind the host (warm retention). */
  backgroundSurface(options: SurfaceIdOptions): Promise<void>;
  /** Tear a surface down and release its process + storage. */
  destroySurface(options: SurfaceIdOptions): Promise<void>;
  /** Foreground the host web surface (all native surfaces recede). */
  foregroundHost(): Promise<void>;
  /** Introspect a surface's live state — for debugging and instrumented tests. */
  getSurfaceState(options: SurfaceIdOptions): Promise<SurfaceState>;
}
