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
    />
  );
}
