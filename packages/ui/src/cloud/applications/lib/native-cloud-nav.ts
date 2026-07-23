/**
 * Native cross-domain navigation helpers for Cloud management inside Projects.
 *
 * Shared Cloud components also link to console-only surfaces and fully external
 * URLs. On web those resolve through the apex BrowserRouter or a new tab; inside
 * the native project shell a cross-domain router link would dead-end and a
 * WebView `target="_blank"` is unreliable.
 *
 * These helpers route those web-only sub-flows to the system browser **on native
 * only**. Every function is a no-op that returns `false` on web, so the call
 * sites keep their existing in-router `<Link>` / `target="_blank"` behavior
 * byte-for-byte — the native branch is gated purely on the runtime detector.
 */

import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "../../../bridge/electrobun-runtime";
import { getBootConfig } from "../../../config/boot-config";
import { openExternalUrl } from "../../../utils/openExternalUrl";

/**
 * True only inside a native (Capacitor iOS/Android) or Electrobun runtime — the
 * surfaces that mount Cloud controls inside Projects rather than the apex
 * `CloudRouterShell`. Always false on web, so every web path is unchanged.
 */
export function isNativeCloudSurfaceRuntime(): boolean {
  return Capacitor.isNativePlatform() || isElectrobunRuntime();
}

/**
 * Resolve an apex-console URL for a `/dashboard/*` route. Derives the web
 * console host from the configured cloud API base, normalizing an `api.` /
 * `api-staging.` API host back to its apex console host (the console serves the
 * dashboard; the API host does not). Falls back to production apex.
 */
export function resolveCloudConsoleUrl(path: string): string {
  const base = getBootConfig().cloudApiBase?.trim() || "https://elizacloud.ai";
  let host = "elizacloud.ai";
  try {
    host = new URL(base).hostname.toLowerCase().replace(/^api[.-]/, "");
  } catch {
    host = "elizacloud.ai";
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `https://${host}${normalizedPath}`;
}

/**
 * On native, open a cross-domain cloud dashboard route (one the studio's
 * MemoryRouter does not mount) in the system browser and report that we handled
 * the navigation. On web, returns `false` so the caller's in-router
 * `<Link>` / `navigate()` handles it.
 */
export function openCloudConsoleRouteExternally(path: string): boolean {
  if (!isNativeCloudSurfaceRuntime()) return false;
  void openExternalUrl(resolveCloudConsoleUrl(path));
  return true;
}

/**
 * On native, open an already-absolute external URL (an app's verified domain,
 * website, or support link) in the system browser — a WebView `target="_blank"`
 * is dropped or hijacks the studio's WebView. Returns `true` when handled.
 * `mailto:` / `tel:` are left to the anchor on both platforms (the OS handles
 * them), and web always returns `false` (the anchor opens a new tab normally).
 */
export function openExternalUrlOnNative(href: string): boolean {
  if (!isNativeCloudSurfaceRuntime()) return false;
  if (/^(mailto:|tel:)/i.test(href)) return false;
  void openExternalUrl(href);
  return true;
}
