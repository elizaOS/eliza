/**
 * Cover-image background layer for the unified app background, given a data or
 * /api/media URL.
 */
import type * as React from "react";

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
 * BOTTOM-EDGE FLOOR (kills the residual "black band"): the wallpaper is a
 * `fixed inset-0` cover-fit layer, so on an iOS standalone PWA it already
 * paints into the home-indicator safe-area at the true screen bottom (that is
 * the whole reason the transparent app-safe-area-floor lets it own the edge).
 * But cover-cropping the stock "Ember Night" sunset — and many user uploads —
 * shows a DARK image region at the very bottom (the sunset floor samples to
 * ~lum 31 after the 0.5 --bg scrim), so the strip under the floating composer
 * read as a near-black band even though the wallpaper was painting there. Prior
 * fixes only removed the OTHER painters of that zone (the orange host-chrome,
 * the opaque bg-bg floor, the launch-bg repaint strip); the residual band was
 * the wallpaper's own dark bottom. A short, bottom-anchored warm floor gradient
 * lifts just the lowest strip toward the ember floor tone the ShaderBackground
 * fallback already pools there, so the home-indicator zone reads as intentional
 * lock-screen ambience in one continuous field with the rest of the wallpaper —
 * never a dead black bar. It fades out fast (well before the composer) so it
 * never washes the wallpaper's content region, and it is wallpaper-agnostic:
 * dark user uploads get the same warm floor. Anchored below the legibility
 * scrim so the scrim still governs the readable middle of the image. */
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
        // BOTTOM-BAR ROOT CAUSE (device r5): this `fixed inset-0` cover image's
        // `bottom: 0` anchors to the fixed-descendant ICB, which COLLAPSES to
        // the small/layout viewport on the installed iOS standalone PWA (~59px
        // short of the true 100lvh bottom). Left alone the wallpaper stops above
        // the home-indicator zone and the dimmed launch-bg shows through as the
        // rgb(61,27,11) bar under the composer. Drop the bottom edge by the
        // collapse delta so the cover image reaches the TRUE physical bottom —
        // the same reclaim the chat composer applies. `max(0px, 100lvh -
        // 100dvh)` is 0 wherever the two viewports agree (desktop/Android), so
        // this is a no-op except on the collapsing iOS-standalone geometry.
        bottom: "calc(-1 * max(0px, 100lvh - 100dvh))",
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Legibility scrim: recede the wallpaper so content wins. Kept INSIDE
          the image layer (not a sibling) so the shell's exactly-one-background
          invariant holds and every image wallpaper — default or user-uploaded —
          gets the same treatment. */}
      <div
        aria-hidden="true"
        data-testid="app-background-image-scrim"
        className="absolute inset-0 bg-bg/50"
      />
      {/* Bottom warm-floor lift: a short gradient anchored at the true bottom
          edge that pulls the lowest strip (the home-indicator safe-area zone
          under the composer) toward the ember floor glow, so a dark wallpaper
          bottom never reads as a black band. Uses the brand ember glow at low
          alpha over the base --bg, matching the ShaderBackground fallback's
          low ember pool; fades to transparent by ~22% up so it only touches
          the bottom edge and never the content region. Sits ABOVE the scrim
          (last child) because it must lift the ALREADY-scrimmed bottom out of
          near-black — putting it under the scrim would just get dimmed back
          down. pointer-events inherit none from the parent. */}
      <div
        aria-hidden="true"
        data-testid="app-background-image-floor"
        className="absolute inset-x-0 bottom-0 h-[22%]"
        style={{
          backgroundImage:
            "linear-gradient(to top, color-mix(in srgb, var(--bg) 62%, #ef5a1f) 0%, transparent 100%)",
        }}
      />
    </div>
  );
}
