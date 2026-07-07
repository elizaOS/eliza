/**
 * Native-shell surface driver contract for the mobile Browser view (#15245,
 * deferred from #14181, child of #13452). On mobile the app renders into a
 * single host web surface (Capacitor `WKWebView` on iOS / Android `WebView`); a
 * view whose resolved {@link ResolvedSurfaceManifest} declares
 * `isolation: "native-webview"` must instead layer its arbitrary web content as
 * its OWN native child web surface with an explicit process/storage-sharing
 * policy, so heavy or untrusted content (the Browser view's third-party tabs)
 * never shares the host renderer process or the host storage partition.
 *
 * This module is the seam between the placement decision — the pure
 * {@link deriveSurfacePlacement}, which reads the manifest alone and says whether
 * a view lives in the host web surface or its own native surface and with what
 * policy — and the native shell that actually owns the layered `WKWebView` /
 * `WebView` stack. The live consumer is
 * `use-mobile-native-tab-surfaces.ts`, which drives one native surface per
 * Browser tab; the production driver (`capacitor-native-surface-shell.ts`)
 * realises these calls through the `ElizaSurfaceManager` Capacitor plugin, and
 * tests drive a faithful in-memory shell. Keeping the driver behind an interface
 * is what lets the isolation decision be tested against the real decision path
 * without a device.
 *
 * The one hard invariant this module encodes: every independent native surface
 * carries an EXPLICIT {@link NativeSurfacePolicy} — process and storage sharing
 * are each a deliberate `"isolated" | "shared"` choice derived from the manifest,
 * never an implicit platform default (#15245 acceptance).
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";

/**
 * Renderer-process sharing for an independent native surface.
 *  - `isolated` — its own renderer process (a fresh `WKProcessPool` on iOS, the
 *                 platform out-of-process renderer on Android). A crash or heavy
 *                 load cannot take down the host webview, and same-process script
 *                 reach is impossible.
 *  - `shared`   — reuses a plugin-owned shared process pool. Only for trusted
 *                 first-party native surfaces that must cooperate with each
 *                 other; never the implicit host default.
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
 * surface. Both axes are always stated — the placement decision never lets the
 * native shell fall back to an implicit default (#15245).
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

/**
 * Screen-space rectangle for a layered native surface, in CSS pixels relative to
 * the host webview's viewport. The native side converts to device pixels by the
 * display density; keeping the interface in CSS px means the JS layer measures
 * with `getBoundingClientRect` and never has to know the device scale factor.
 */
export interface SurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Request to create one independent native web surface. */
export interface NativeSurfaceCreateRequest {
  /** Stable per-surface id; the caller keys foreground/bounds/destroy on it. */
  readonly id: string;
  /** Initial content URL, when the caller knows it. */
  readonly url?: string;
  /** The explicit, non-default process/storage policy for this surface. */
  readonly policy: NativeSurfacePolicy;
}

/**
 * The native shell that owns the layered surface stack. The renderer issues these
 * commands; the native side (or a test double) realises them as real
 * `WKWebView` / `WebView` layers. All methods are side-effecting and synchronous
 * from the caller's perspective — ordering is the caller's contract, not the
 * shell's.
 */
export interface NativeSurfaceShell {
  /**
   * Create (but do not necessarily foreground) a native surface with the given
   * explicit policy. Must be called before {@link foregroundSurface} for an id.
   */
  createSurface(req: NativeSurfaceCreateRequest): void;
  /**
   * Position a surface over the host webview. Called on layout/resize/scroll so
   * the native layer tracks the placeholder rect the React tree reserves for it.
   */
  setBounds(id: string, bounds: SurfaceBounds): void;
  /** Load a URL in an existing surface (address-bar navigation on the tab). */
  navigate(id: string, url: string): void;
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
