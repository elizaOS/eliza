/**
 * Re-exports the shared API/app asset URL resolvers so UI callers use one
 * canonical origin-aware helper, plus the wallpaper-URL resolver both the box
 * image layer and the root-canvas mirror depend on.
 */
import {
  resolveApiUrl,
  resolveAppAssetUrl,
} from "@elizaos/shared/utils/asset-url";

export {
  resolveApiUrl,
  resolveAppAssetUrl,
} from "@elizaos/shared/utils/asset-url";

/**
 * Resolve a wallpaper `imageUrl` into one reachable from the renderer in every
 * shell (web, packaged desktop `file://`, native `capacitor://`). The stored
 * URL is one of three same-origin classes, each resolving against a DIFFERENT
 * runtime base. `ImageBackground` (the box image) and `html-canvas-paint` (the
 * root-canvas mirror that fills the iOS standalone bottom strip) MUST resolve
 * identically, so the resolution lives here once instead of drifting in two copies:
 *  - `data:` / `blob:` / absolute `http(s):` / protocol-relative `//` — any URL
 *    that already carries a scheme (or is protocol-relative) passes through.
 *  - `/api/media/<hash>` (a re-hosted upload/generation) — an AGENT-API path, so
 *    resolve against the runtime API base; a bare `/api/…` on `file://` would
 *    point at the SPA, not the backend, and 404.
 *  - `/bg-sunset.webp` / `/wallpapers/<id>.webp` (curated static assets in
 *    `packages/app/public`) — a PUBLIC ASSET path, so resolve against the SPA
 *    asset base; on packaged `file://` a bare `/wallpapers` would resolve to
 *    `file:///wallpapers` and fail.
 */
export function resolveWallpaperUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
    return url;
  }
  if (url.startsWith("/api/") || url.startsWith("api/")) {
    return resolveApiUrl(url);
  }
  return resolveAppAssetUrl(url);
}
