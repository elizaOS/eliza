import type { SVGProps } from "react";

import { FeedMark } from "./FeedMark";

interface FeedFullLogoProps extends SVGProps<SVGSVGElement> {
  /**
   * Render the smiley mascot mark beside the wordmark. Defaults to `true`.
   * Set `false` for a text-only "feed" wordmark.
   */
  withMark?: boolean;
}

/**
 * Full Feed logo: the smiley mascot mark plus a real, selectable "feed"
 * wordmark rendered as live text (not baked-into-path letterforms). The text
 * inherits the app font via `--font-geist-sans` and themes through
 * `currentColor`, so setting the parent text color recolors the whole logo.
 */
export function FeedFullLogo({
  className,
  withMark = true,
  ...props
}: FeedFullLogoProps) {
  // With the mark the wordmark sits to its right; text-only starts at the edge.
  const textX = withMark ? 720 : 0;
  const viewBoxWidth = withMark ? 1500 : 800;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxWidth} 573.41`}
      className={className}
      role="img"
      aria-label="feed"
      {...props}
    >
      {withMark ? <FeedMark /> : null}
      <text
        x={textX}
        y={418}
        fill="currentColor"
        fontFamily="var(--font-geist-sans), system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontSize={380}
        fontWeight={800}
        letterSpacing={0}
      >
        feed
      </text>
    </svg>
  );
}
