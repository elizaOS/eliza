/**
 * Cover-image background layer for the unified app background, given a data or
 * /api/media URL.
 */
import type * as React from "react";
import { STANDALONE_BOTTOM_RECLAIM_OFFSET } from "../platform/standalone-bottom-reclaim";

export interface ImageBackgroundProps {
  /** Cover-image source — a data URL or a served `/api/media/…` URL. */
  imageUrl: string;
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
 * BOTTOM-EDGE FLOOR (device r6): the wallpaper is a `fixed inset-0` cover-fit
 * layer that now reaches the TRUE physical bottom on the installed iOS
 * standalone PWA via the JS-MEASURED `--standalone-bottom-reclaim` on its
 * `bottom` (below). Because the wallpaper genuinely owns the whole screen down
 * to the home-indicator edge, NO cosmetic bottom-floor gradient is needed: the
 * prior warm-ember lift strip (removed) existed only to disguise the launch-bg
 * band that showed when the wallpaper stopped ~59px short under the useless
 * CSS-unit reclaim. With the measured reclaim the wallpaper's own pixels fill
 * the edge, lock-screen style, so we mount ONLY the legibility scrim and let
 * the image itself paint the bottom — no dead band, no cosmetic strip. */
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
        // BOTTOM-BAR ROOT CAUSE (device r6, JS-MEASURED cure): this
        // `fixed inset-0` cover image's `bottom: 0` anchors to the
        // fixed-descendant ICB, which COLLAPSES to the small/layout viewport on
        // the installed iOS standalone PWA (~59px short of the true physical
        // bottom). Left alone the wallpaper stops above the home-indicator zone
        // and the dimmed launch-bg shows through as the near-black bar. Drop the
        // bottom edge by the MEASURED collapse gap
        // (`--standalone-bottom-reclaim`, set in JS from window/visualViewport
        // vs documentElement.clientHeight) so the cover image reaches the TRUE
        // physical bottom. The prior `max(0px, 100lvh - 100dvh)` CSS-unit calc
        // was a NO-OP on device because the collapsed fixed-body ICB resolves
        // BOTH lvh and dvh to the same collapsed box (delta 0) — the reason the
        // strip survived 5 CSS-only fixes. The var is a hard 0 off-standalone.
        bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Legibility scrim: recede the wallpaper so content wins. Kept INSIDE
          the image layer (not a sibling) so the shell's exactly-one-background
          invariant holds and every image wallpaper — default or user-uploaded —
          gets the same treatment. NO cosmetic bottom-floor gradient below it:
          the measured reclaim (parent `bottom`) makes the wallpaper reach the
          true physical bottom, so the image's own pixels own the
          home-indicator edge, lock-screen style. */}
      <div
        aria-hidden="true"
        data-testid="app-background-image-scrim"
        className="absolute inset-0 bg-bg/50"
      />
    </div>
  );
}
