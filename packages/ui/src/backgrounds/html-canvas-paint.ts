/**
 * Mirrors the active wallpaper onto the root viewport canvas, curing the
 * recurring iOS standalone-PWA "bottom bar" where fixed app boxes can stop
 * short of the drawable screen.
 *
 * ── WHY A CANVAS PAINT AND NOT ANOTHER BOX FIX ──
 * Per the CSS backgrounds spec, the background of the ROOT element (`html`)
 * propagates to the *viewport CANVAS* — the infinite painting surface behind
 * every box. Unlike any box (which is subject to the collapsed fixed-body
 * initial-containing-block on standalone iOS — the ~59px short we've chased for
 * eight recurrences), the canvas ALWAYS covers the entire drawable screen down
 * to the physical bottom. Box geometry, ICB collapse, fixed-positioning
 * contexts, lvh/dvh unit resolution — NONE of it affects canvas paint.
 *
 * The strip we still see on build f42baade5a is exactly this: `html`/`body`
 * carry `--launch-bg` (#160d07), so wherever every box stops short of the true
 * bottom, the canvas shows that near-black through the gap. #160d07 IS the
 * strip.
 *
 * ── THE FIX ──
 * When a wallpaper/background is active, mirror it onto the ROOT element so the
 * canvas shows THE WALLPAPER (or its dominant bottom-edge color) instead of the
 * near-black launch-bg:
 *   - image mode → `html { background-image: url(<wallpaper>); background-size:
 *     cover; background-position: center bottom }` — the canvas paints the same
 *     cover image, so the strip becomes the wallpaper's own bottom pixels.
 *   - shader / glsl / color mode → `html { background-color: <base color> }` —
 *     there is no static image to mirror (the shader paints on a WebGL canvas in
 *     a box), so we mirror the field's base color; the strip matches the shader
 *     field's darkest tone instead of #160d07.
 *
 * This is invisible-by-construction: it does not depend on measuring the gap
 * correctly. Even if viewport APIs report a collapsed layout viewport, the
 * canvas still paints the wallpaper, so the strip is gone regardless.
 *
 * ── FOUC / --launch-bg ──
 * `index.html` sets `--launch-bg` on `:root` as the pre-boot paint (avoids a
 * white flash before the JS boots). We do NOT touch index.html: this runtime
 * mirror sets an INLINE style on `document.documentElement`, which wins over the
 * stylesheet `:root` rule by specificity, so the moment the app knows its
 * wallpaper the canvas upgrades from launch-bg to the real background. Before
 * that first mirror, the FOUC guard is untouched.
 *
 * App-lifetime: the mirror is updated on every background change and never torn
 * down (the background layer is mounted once at the shell root for the whole
 * session).
 */

import type { BackgroundConfig } from "../state/ui-preferences";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { resolveApiUrl, resolveAppAssetUrl } from "../utils/asset-url";

/**
 * Resolve a wallpaper `imageUrl` into one reachable from the renderer in every
 * shell — the SAME resolution `ImageBackground` uses so the canvas mirror and
 * the box image reference identical bytes (no double-fetch of a different URL).
 *  - `data:` / `blob:` / absolute `http(s):` / protocol-relative — pass through.
 *  - `/api/media/<hash>` — an agent-API path, resolve against the API base.
 *  - `/wallpapers/<id>.webp` / `/bg-sunset.webp` — a public static asset, resolve
 *    against the SPA asset base (correct on packaged `file://` / `capacitor://`).
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

/** What to write onto the root element's background to drive the canvas paint. */
export interface RootCanvasPaint {
  /** `background-image` value (a `url("…")`) when an image wallpaper is active. */
  backgroundImage: string | null;
  /** `background-color` value — the dominant bottom-edge color under the image,
   *  or the shader/color field base when there is no image. Always set so the
   *  canvas never falls back to the near-black launch-bg. */
  backgroundColor: string;
}

/**
 * Compute the root-canvas paint for a background config.
 *
 * IMAGE: mirror the cover image (so the canvas shows the wallpaper's own bottom
 * pixels) AND set a background-color to the config's base as the fill behind a
 * still-loading / transparent-edged image, so the reveal is warm, never
 * near-black.
 *
 * SHADER / GLSL / COLOR: no static image to mirror (the shader is a WebGL canvas
 * inside a box); mirror the field's base color so the strip matches the field's
 * darkest tone instead of #160d07.
 */
export function computeRootCanvasPaint(
  config: BackgroundConfig | null | undefined,
): RootCanvasPaint {
  const baseColor =
    config && typeof config.color === "string" && config.color.length > 0
      ? config.color
      : DEFAULT_BACKGROUND_COLOR;

  if (config?.mode === "image" && config.imageUrl) {
    return {
      backgroundImage: `url("${resolveWallpaperUrl(config.imageUrl)}")`,
      backgroundColor: baseColor,
    };
  }

  // shader / glsl / color, or a malformed/empty config: no image to mirror.
  return { backgroundImage: null, backgroundColor: baseColor };
}

/**
 * Apply the computed paint onto `document.documentElement` as INLINE styles.
 * Inline wins over the `:root { --launch-bg }` stylesheet rule by specificity,
 * so this upgrades the canvas from the FOUC launch-bg to the real wallpaper the
 * moment the app knows it. No-op under SSR / missing document.
 *
 * `background-position: center bottom` deliberately anchors the cover image to
 * the BOTTOM edge: the box wallpaper uses `center`, but the canvas exists
 * specifically to fill the strip UNDER the
 * box, so biasing its crop toward the bottom keeps the seam between the box
 * image and the canvas image visually continuous at the home-indicator edge.
 */
export function applyRootCanvasPaint(
  config: BackgroundConfig | null | undefined,
): RootCanvasPaint {
  const paint = computeRootCanvasPaint(config);
  if (typeof document === "undefined") return paint;
  const root = document.documentElement;
  if (!root) return paint;

  root.style.backgroundColor = paint.backgroundColor;
  if (paint.backgroundImage) {
    root.style.backgroundImage = paint.backgroundImage;
    root.style.backgroundSize = "cover";
    root.style.backgroundPosition = "center bottom";
    root.style.backgroundRepeat = "no-repeat";
  } else {
    // Shader / color field: clear any prior image so the canvas is a flat fill
    // of the field base (a stale prior wallpaper must not linger on the canvas
    // after the user switches to a shader/color background).
    root.style.backgroundImage = "";
    root.style.backgroundSize = "";
    root.style.backgroundPosition = "";
    root.style.backgroundRepeat = "";
  }
  return paint;
}
