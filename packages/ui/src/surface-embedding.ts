/**
 * Turns a view's declared `native-webview` isolation level into the concrete
 * web-content embedding its page actually renders into, per host platform — the
 * enforcement half of the isolation catalogue (#14181, parent #13452). The
 * catalogue in `surface-isolation.ts` *documents* that `native-webview` views
 * embed a native child web-content surface with its own renderer process; this
 * module is what makes that documentation authoritative: the Browser view's tab
 * renderer reads the resolved manifest through {@link resolveBrowserTabRenderPath}
 * and hands out the native child surface ONLY when the manifest declares
 * `native-webview`, so no view that did not opt into that level can ever be
 * given (or wrongly denied) a separate-renderer native surface.
 *
 * The isolation guarantee this protects: arbitrary third-party web content in
 * the Browser view must never share the host renderer realm — its DOM, globals,
 * storage, and a crash/heavy-load in it must not reach the shell. On desktop
 * that separation is a real, distinct renderer process (the Electron/Electrobun
 * `WebContentsView` / CEF OOPIF the Browser view already mounts); this resolver
 * is the single decision point that selects it.
 *
 * Consumer: `packages/ui/src/components/pages/BrowserWorkspaceView.tsx` (the tab
 * render branch). The per-platform target table {@link NATIVE_WEBVIEW_EMBEDDINGS}
 * is the typed, greppable statement of which native primitive each platform uses
 * and its process/storage-sharing policy — read alongside the catalogue.
 */

import type { SurfaceIsolationLevel } from "@elizaos/core";
import type { BrowserWorkspaceMode } from "./api/browser-contracts";

/**
 * The concrete render path the Browser view uses for a tab's page content.
 *
 *  - `native-child-webview` — a native child web-content surface with its own
 *    renderer process (desktop `WebContentsView` / CEF OOPIF). Third-party web
 *    content runs fully outside the host renderer realm. Selected only when the
 *    resolved manifest declares `native-webview`.
 *  - `sandboxed-iframe` — a sandboxed in-realm `<iframe>` (the web platform has
 *    no native child surface, so `native-webview` degrades to a cross-origin
 *    sandboxed iframe there).
 *  - `server-snapshot` — a server-rendered screenshot preview (cloud mode never
 *    runs page content locally).
 */
export type BrowserTabRenderPath =
  | "native-child-webview"
  | "sandboxed-iframe"
  | "server-snapshot";

/**
 * Resolve which embedding the Browser view uses for its tabs, from the view's
 * declared isolation level and the running host mode.
 *
 * The one enforced invariant (#14181): `native-child-webview` — the only path
 * that hands page content a separate renderer process — is returned **iff** the
 * manifest declares `isolation: "native-webview"` AND the host is the desktop
 * shell that can host a native child surface. Any other isolation level, on any
 * mode, can never resolve to the native surface: it degrades to the in-realm
 * sandboxed iframe (or the cloud snapshot). This is what stops a view that did
 * not opt into `native-webview` from being handed a native renderer surface,
 * and stops the Browser view from silently losing it if its manifest drifts.
 */
export function resolveBrowserTabRenderPath(input: {
  isolation: SurfaceIsolationLevel;
  mode: BrowserWorkspaceMode;
}): BrowserTabRenderPath {
  const { isolation, mode } = input;

  // Cloud shows a server-rendered snapshot; no local web content runs, so the
  // isolation level does not select a local embedding here.
  if (mode === "cloud") return "server-snapshot";

  // The native child web-content surface exists only on the desktop shell and
  // is granted only to the declared `native-webview` level. This conjunction is
  // the enforcement point: drop either condition and no native surface is used.
  if (mode === "desktop" && isolation === "native-webview") {
    return "native-child-webview";
  }

  // Web platform (no native child surface) and any non-`native-webview` view
  // both land here: a sandboxed, in-realm iframe. Third-party content is served
  // cross-origin so the sandbox is meaningful.
  return "sandboxed-iframe";
}

/** The platforms that provide a native child web-content surface. */
export const NATIVE_WEBVIEW_PLATFORMS = ["desktop", "ios", "android"] as const;

/** A platform that can host the `native-webview` embedding. */
export type NativeWebviewPlatform = (typeof NATIVE_WEBVIEW_PLATFORMS)[number];

/**
 * The native primitive + process/storage policy each platform uses to embed
 * `native-webview` content. The durable, typed answer to "what actually hosts
 * the Browser view's page content, and how isolated is it" per platform.
 */
export interface NativeWebviewEmbedding {
  readonly platform: NativeWebviewPlatform;
  /** The native primitive that hosts the child web content. */
  readonly primitive: string;
  /**
   * The defining property of this level: the embedded content runs in a
   * renderer process distinct from the host shell's renderer, so its crash or
   * heavy load cannot take down the shell and its realm is not shared.
   */
  readonly separateRendererProcess: true;
  /** The web-storage sharing policy between the child surface and the host. */
  readonly storagePolicy: string;
}

/**
 * The per-platform `native-webview` embedding target. Desktop is wired today
 * (the Browser view mounts the CEF OOPIF `<electrobun-webview renderer="cef">`
 * with a per-tab storage partition); iOS/Android name the native primitive and
 * process/storage policy the mobile shell embeds the Browser view with.
 */
export const NATIVE_WEBVIEW_EMBEDDINGS: Readonly<
  Record<NativeWebviewPlatform, NativeWebviewEmbedding>
> = {
  desktop: {
    platform: "desktop",
    primitive: "Electron/Electrobun WebContentsView (CEF out-of-process frame)",
    separateRendererProcess: true,
    storagePolicy: "per-tab persistent partition (persist:<tab-partition>)",
  },
  ios: {
    platform: "ios",
    primitive: "WKWebView backed by a dedicated WKProcessPool",
    separateRendererProcess: true,
    storagePolicy:
      "own WKWebsiteDataStore, not shared with the app's host web view",
  },
  android: {
    platform: "android",
    primitive: "WebView with out-of-process renderer (renderer isolation)",
    separateRendererProcess: true,
    storagePolicy: "app-scoped WebView storage behind an isolated renderer",
  },
};

/** The native embedding descriptor for a platform. */
export function nativeWebviewEmbedding(
  platform: NativeWebviewPlatform,
): NativeWebviewEmbedding {
  return NATIVE_WEBVIEW_EMBEDDINGS[platform];
}
