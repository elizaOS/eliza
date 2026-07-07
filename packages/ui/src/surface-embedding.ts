/**
 * Turns a view's declared `native-webview` isolation level into the concrete
 * web-content embedding its page actually renders into, per host platform — the
 * enforcement half of the isolation catalogue (#14181, parent #13452). The
 * catalogue in `surface-isolation.ts` *documents* that `native-webview` views
 * embed a native child web-content surface with its own renderer process; this
 * module is what makes that documentation authoritative: the Browser view's tab
 * renderer reads the resolved manifest through {@link resolveBrowserTabRenderPath}
 * and hands out a native child surface ONLY when the manifest declares
 * `native-webview`, so no view that did not opt into that level can ever be
 * given (or wrongly denied) a separate-renderer native surface.
 *
 * The isolation guarantee this protects: arbitrary third-party web content in
 * the Browser view must never share the host renderer realm — its DOM, globals,
 * storage, and a crash/heavy-load in it must not reach the shell. On desktop
 * that separation is a real, distinct renderer process (the Electron/Electrobun
 * `WebContentsView` / CEF OOPIF the Browser view already mounts); on a native
 * mobile shell it is a layered native web surface in its own renderer process;
 * this resolver is the single decision point that selects the right one.
 *
 * Consumer: `packages/ui/src/components/pages/BrowserWorkspaceView.tsx` (the tab
 * render branch). Per-platform native targets (named by the catalogue): desktop
 * Electron/Electrobun `WebContentsView` (CEF out-of-process frame, per-tab
 * `persist:` partition); a native mobile shell (Capacitor iOS/Android, not the
 * mobile web browser) layers each tab as a `native-mobile-webview` — iOS
 * `WKWebView` on a dedicated `WKProcessPool` + non-persistent
 * `WKWebsiteDataStore`, Android `WebView` with the platform out-of-process
 * renderer + its own androidx.webkit `Profile` (#15245, deferred from #14181).
 * Only a plain mobile-web host, which has no native child surface, still degrades
 * `native-webview` to a `sandboxed-iframe`; cloud shows a server snapshot.
 */

import type { SurfaceIsolationLevel } from "@elizaos/core";
import type { BrowserWorkspaceMode } from "./api/browser-contracts";

/**
 * The concrete render path the Browser view uses for a tab's page content.
 *
 *  - `native-child-webview` — a desktop native child web-content surface with
 *    its own renderer process (`WebContentsView` / CEF OOPIF). Third-party web
 *    content runs fully outside the host renderer realm. Selected only when the
 *    resolved manifest declares `native-webview` on the desktop shell.
 *  - `native-mobile-webview` — a native mobile child web surface: an iOS
 *    `WKWebView` on its own `WKProcessPool` + non-persistent data store, or an
 *    Android out-of-process `WebView` with its own storage profile. Same
 *    separate-process isolation as desktop, for the Capacitor mobile shell.
 *    Selected only when the resolved manifest declares `native-webview` and the
 *    host is a native mobile shell.
 *  - `sandboxed-iframe` — a sandboxed in-realm `<iframe>` (a plain web host has
 *    no native child surface, so `native-webview` degrades to a cross-origin
 *    sandboxed iframe there).
 *  - `server-snapshot` — a server-rendered screenshot preview (cloud mode never
 *    runs page content locally).
 */
export type BrowserTabRenderPath =
  | "native-child-webview"
  | "native-mobile-webview"
  | "sandboxed-iframe"
  | "server-snapshot";

/**
 * Resolve which embedding the Browser view uses for its tabs, from the view's
 * declared isolation level, the running host mode, and whether the host is a
 * native mobile shell (Capacitor iOS/Android — distinct from the mobile web
 * browser, which reports `mode: "web"` too, so it cannot be inferred from mode
 * alone; the caller passes it explicitly).
 *
 * The one enforced invariant (#14181/#15245): the two separate-renderer-process
 * paths — `native-child-webview` (desktop) and `native-mobile-webview` (native
 * mobile shell) — are returned **iff** the manifest declares
 * `isolation: "native-webview"` AND the host can actually host a native child
 * surface. Any other isolation level, on any host, can never resolve to either
 * native path: it degrades to the in-realm sandboxed iframe (or the cloud
 * snapshot). This is what stops a view that did not opt into `native-webview`
 * from being handed a native renderer surface, and stops the Browser view from
 * silently losing it if its manifest drifts.
 */
export function resolveBrowserTabRenderPath(input: {
  isolation: SurfaceIsolationLevel;
  mode: BrowserWorkspaceMode;
  nativeMobileShell: boolean;
}): BrowserTabRenderPath {
  const { isolation, mode, nativeMobileShell } = input;

  // Cloud shows a server-rendered snapshot; no local web content runs, so the
  // isolation level does not select a local embedding here.
  if (mode === "cloud") return "server-snapshot";

  const wantsNative = isolation === "native-webview";

  // The desktop native child web-content surface: granted only to the declared
  // `native-webview` level on the desktop shell. This conjunction is the
  // enforcement point — drop either condition and no native surface is used.
  if (mode === "desktop" && wantsNative) {
    return "native-child-webview";
  }

  // The native mobile shell (Capacitor iOS/Android) layers each tab as its own
  // native web surface. Same conjunction, same guarantee, different platform.
  if (nativeMobileShell && wantsNative) {
    return "native-mobile-webview";
  }

  // A plain web host (no native child surface) and any non-`native-webview` view
  // both land here: a sandboxed, in-realm iframe. Third-party content is served
  // cross-origin so the sandbox is meaningful.
  return "sandboxed-iframe";
}
