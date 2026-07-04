import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Base skeleton block: an aria-hidden pulsing placeholder. The single skeleton
 * primitive in the kit — composite shapes live in `skeleton-layouts.tsx`, built
 * on this.
 */
const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("animate-pulse rounded-sm bg-bg-accent", className)}
    {...props}
  />
));
Skeleton.displayName = "Skeleton";

export { Skeleton };
