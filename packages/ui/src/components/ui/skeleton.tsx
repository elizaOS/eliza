import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * The only Skeleton primitive with consumers. The other variants
 * (SkeletonLine, SkeletonText, SkeletonCard, SkeletonChat,
 * SkeletonMessage, SkeletonSidebar) were deleted in the Layer 5b sweep
 * — none had consumers outside this file.
 */
const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("animate-pulse rounded-md bg-bg-accent", className)}
    {...props}
  />
));
Skeleton.displayName = "Skeleton";

export { Skeleton };
