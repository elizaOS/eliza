/**
 * Cover-image background layer for the unified app background, given a data or
 * /api/media URL.
 */
import type * as React from "react";
import { STANDALONE_BOTTOM_RECLAIM_OFFSET } from "../platform/standalone-bottom-reclaim";
import { resolveApiUrl, resolveAppAssetUrl } from "../utils/asset-url";

export interface ImageBackgroundProps {
  /** Cover-image source — a data URL or a served `/api/media/…` URL. */
  imageUrl: string;
}

/**
 * Resolve a wallpaper `imageUrl` into one reachable from the renderer in every
 * shell (web, packaged desktop `file://`, native `capacitor://`). The stored URL
 * is one of three same-origin classes and each resolves against a DIFFERENT
 * runtime base:
 *  - `data:` / `blob:` / already-absolute `http(s)` — pass through untouched.
 *  - `/api/media/<hash>` (a re-hosted upload/generation) — an AGENT-API path, so
 *    resolve it against the runtime API base (`resolveApiUrl`); a bare `/api/…`
 *    on `file://` would point at the SPA, not the backend, and 404.
 *  - `/bg-sunset.webp` / `/wallpapers/<id>.webp` (curated static assets in
 *    `packages/app/public`) — a PUBLIC ASSET path, so resolve it against the SPA
 *    asset base (`resolveAppAssetUrl`); on packaged `file://` a bare `/wallpapers`
 *    would resolve to `file:///wallpapers` and fail. This is the same
 *    URL-resolution trap `resolveTileImageUrl` handles for launcher hero art.
 */
function resolveWallpaperUrl(url: string): string {
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(url) ||
    url.startsWith("//")
  ) {
    return url;
  }
  if (url.startsWith("/api/") || url.startsWith("api/")) {
    return resolveApiUrl(url);
  }
  return resolveAppAssetUrl(url);
}

/**
 * A full-bleed cover image for the unified app background. Centered, cover-fit,
 * no repeat — the user's uploaded or generated wallpaper sits behind the home
 * and every view that opts into the shared background.
 *
 * The image is always painted UNDER a half-strength `--bg` scrim (the child
 * layer below). A photo wallpaper is ambience, not content: without the scrim
 * a bright, saturated image (the stock sunset especially) competes with the
 * greeting, cards, and composer sitting on top of it. Mixing 50% of the page
 * background over the photo pulls its brightness, contrast, AND chroma toward
 * the theme's base surface, so foreground text wins in both themes — dark mode
 * dims the photo toward the warm brand black, light mode lifts it toward the
 * warm white that dark text needs. A token scrim (no blur, no per-pixel
 * filter work) is also the cheapest possible treatment: one plain composited
 * layer, gate-safe, GPU-trivial.
 *
 * BOTTOM EDGE: the wallpaper is a `fixed inset-0` cover-fit layer. On the
 * installed iOS standalone PWA the `fixed` containing block does NOT resolve to
 * the true 932px screen — it collapses to the small ICB (`ce873` while the
 * physical screen is `sh932`, device-verified), so a bare `inset-0`
 * (`bottom: 0`) stops the wallpaper ~59px SHORT of the home-indicator edge and
 * that dead band paints as the recurring black strip. We reclaim it by dropping
 * this layer's `bottom` by the JS-MEASURED gap `--standalone-bottom-reclaim`
 * (#15036) so the wallpaper genuinely owns the whole screen down to the
 * home-indicator edge, lock-screen style. The var is a hard 0 off the
 * iOS-standalone/native surface, so this is a true no-op on desktop/web/Android.
 * No cosmetic bottom-floor gradient is needed (the prior warm-ember lift strip
 * existed only to disguise that launch-bg band); we mount ONLY the legibility
 * scrim. */
export function ImageBackground({
  imageUrl,
}: ImageBackgroundProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid="app-background-image"
      data-eliza-bg="image"
      className="pointer-events-none fixed inset-0"
      style={{
        zIndex: 0,
        // BOTTOM-BAR FIX (consume #15036 reclaim): extend the fixed wallpaper
        // DOWN past the collapsed ICB to the TRUE physical bottom by the
        // JS-MEASURED `--standalone-bottom-reclaim`, overriding the `inset-0`
        // `bottom: 0` from the class. See the BOTTOM EDGE note above.
        bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET,
        backgroundImage: `url("${resolveWallpaperUrl(imageUrl)}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Legibility scrim: recede the wallpaper so content wins. Kept INSIDE
          the image layer (not a sibling) so the shell's exactly-one-background
          invariant holds and every image wallpaper — default or user-uploaded —
          gets the same treatment. NO cosmetic bottom-floor gradient below it:
          the fixed wallpaper and mirrored root canvas make the image's own
          pixels own the home-indicator edge, lock-screen style. */}
      <div
        aria-hidden="true"
        data-testid="app-background-image-scrim"
        className="absolute inset-0 bg-bg/50"
      />
    </div>
  );
}
