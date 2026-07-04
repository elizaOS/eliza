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
 */
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
    </div>
  );
}
