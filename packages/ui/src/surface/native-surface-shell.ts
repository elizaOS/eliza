/**
 * Native-shell surface driver contract for the mobile view manager (#14182,
 * child of #13452). On mobile the app renders into a single host web surface
 * (Capacitor `WKWebView` / Android `WebView`); a view whose resolved
 * {@link ResolvedSurfaceManifest} declares `isolation: "native-webview"` must
 * instead be layered as its OWN native child web surface with an explicit
 * process/storage-sharing policy, so heavy or untrusted web content (the Browser
 * view) never shares the host renderer process or the host storage partition.
 *
 * This module is the seam between the platform-agnostic
 * {@link MobileSurfaceManager} (which decides, from the manifest alone, whether a
 * view lives in the host web surface or its own native surface and how long it is
 * retained) and the native shell that actually owns the layered `WKWebView` /
 * `WebView` stack. The manager depends only on {@link NativeSurfaceShell}; the
 * production driver (`capacitor-native-surface-shell.ts`) translates these calls
 * into the native plugin, and tests drive a faithful in-memory shell. Keeping the
 * driver behind an interface is what lets the isolation decision be tested
 * against the real decision path without a device.
 *
 * The one hard invariant this module encodes: every independent native surface
 * carries an EXPLICIT {@link NativeSurfacePolicy} — process and storage sharing
 * are each a deliberate `"isolated" | "shared"` choice derived from the manifest,
 * never an implicit platform default (#14182 acceptance).
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";

/**
 * Renderer-process sharing for an independent native surface.
 *  - `isolated` — its own renderer process (`WKProcessPool` on iOS, a separate
 *                 Android renderer). A crash or heavy load cannot take down the
 *                 host webview, and same-process script reach is impossible.
 *  - `shared`   — reuses the host process pool. Only for trusted first-party
 *                 native surfaces that must cooperate with the host.
 */
export type SurfaceProcessSharing = "isolated" | "shared";

/**
 * Persistent-storage sharing for an independent native surface.
 *  - `isolated` — its own website data store (cookies, localStorage, IndexedDB,
 *                 caches). Nothing written here is visible to the host or to a
 *                 sibling surface — the boundary that stops state leaking across
 *                 surfaces (#13452).
 *  - `shared`   — the host-scoped persistent store. Only when the view's manifest
 *                 grants the `storage` capability, i.e. it explicitly opts into
 *                 host storage.
 */
export type SurfaceStorageSharing = "isolated" | "shared";

/**
 * The explicit process/storage-sharing policy for one independent native web
 * surface. Both axes are always stated — the manager never lets the native shell
 * fall back to an implicit default (#14182).
 */
export interface NativeSurfacePolicy {
  readonly process: SurfaceProcessSharing;
  readonly storage: SurfaceStorageSharing;
}

/**
 * Where a view is placed on mobile. `host-web` views (in-process, immersive,
 * sandboxed-iframe) render inside the single host web surface; `native-surface`
 * views (`native-webview` isolation) get their own layered native web surface
 * governed by an explicit {@link NativeSurfacePolicy}.
 */
export type SurfacePlacement =
  | { readonly target: "host-web" }
  | { readonly target: "native-surface"; readonly policy: NativeSurfacePolicy };

/**
 * Decide, from the resolved manifest alone, where a view is placed and — for a
 * native surface — its explicit process/storage policy. This is the whole
 * manifest→placement decision, kept pure so it is trivially testable and so
 * changing the manifest is the only way to change the outcome (no hidden host
 * state feeds in).
 *
 * `native-webview` is the only level that gets an independent native surface;
 * every other level (in-process, immersive, sandboxed-iframe) lives in the host
 * web surface — a sandboxed iframe is still a child of the host document, not a
 * native sibling. A native surface always isolates its renderer process (the
 * reason to embed a native child at all is to keep heavy/untrusted content out
 * of the host renderer). Storage is isolated by default and only shared when the
 * manifest grants `storage`, i.e. the view explicitly asked for host storage.
 */
export function deriveSurfacePlacement(
  manifest: ResolvedSurfaceManifest,
): SurfacePlacement {
  if (manifest.isolation !== "native-webview") {
    return { target: "host-web" };
  }
  return {
    target: "native-surface",
    policy: {
      process: "isolated",
      storage: manifest.capabilities.has("storage") ? "shared" : "isolated",
    },
  };
}

/** Request to create one independent native web surface. */
export interface NativeSurfaceCreateRequest {
  /** Stable per-view id; the manager keys retention on it. */
  readonly id: string;
  /** Initial content URL, when the manager knows it. */
  readonly url?: string;
  /** The explicit, non-default process/storage policy for this surface. */
  readonly policy: NativeSurfacePolicy;
}

/**
 * The native shell that owns the layered surface stack. The manager issues these
 * commands; the native side (or a test double) realises them as real
 * `WKWebView` / `WebView` layers. All methods are side-effecting and synchronous
 * from the manager's perspective — ordering is the manager's contract, not the
 * shell's.
 */
export interface NativeSurfaceShell {
  /**
   * Create (but do not necessarily foreground) a native surface with the given
   * explicit policy. Must be called before {@link foregroundSurface} for an id.
   */
  createSurface(req: NativeSurfaceCreateRequest): void;
  /** Bring an existing surface to the front, on top of the host. */
  foregroundSurface(id: string): void;
  /** Keep a surface alive but move it behind the foreground (warm retention). */
  backgroundSurface(id: string): void;
  /** Tear a surface down and release its process + storage. */
  destroySurface(id: string): void;
  /** Foreground the host web surface (used when returning to an in-process view). */
  foregroundHost(): void;
  /** Whether a surface with this id currently exists in the shell. */
  hasSurface(id: string): boolean;
}
