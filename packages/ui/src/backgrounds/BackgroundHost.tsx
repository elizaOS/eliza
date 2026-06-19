import { SOLID_BACKGROUND_CSS } from "./types";

export interface BackgroundHostProps {
  className?: string;
}

/**
 * Static, solid shell background.
 *
 * The always-mounted app shell uses a single solid color sourced from the
 * theme's `--background` token (with a sky-blue fallback). There is no
 * animation, no `<video>`, no canvas, and no requestAnimationFrame loop — a
 * deliberate product decision so the background never consumes CPU/GPU while
 * the shell is mounted.
 */
export function BackgroundHost({
  className,
}: BackgroundHostProps): React.JSX.Element {
  return (
    <div
      className={className}
      data-eliza-background-host=""
      data-eliza-bg="solid"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        background: SOLID_BACKGROUND_CSS,
      }}
    />
  );
}
