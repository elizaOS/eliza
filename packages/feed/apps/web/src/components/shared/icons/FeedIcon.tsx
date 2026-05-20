import type { SVGProps } from "react";

import { FeedMark } from "./FeedMark";

/**
 * Feed mascot icon (mark only, no wordmark).
 * Uses currentColor for theming - set text color on parent to change fill.
 */
export function FeedIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 623.67 553.29"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <FeedMark />
    </svg>
  );
}
