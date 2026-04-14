import * as React from "react";

import { cn } from "../../../lib/utils";
import type {
  PagePanelContentAreaProps,
  PagePanelFrameProps,
} from "./page-panel-types";

export const PagePanelFrame = React.forwardRef<
  HTMLDivElement,
  PagePanelFrameProps
>(function PagePanelFrame({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full w-full min-h-0 bg-transparent p-0 lg:p-1",
        className,
      )}
      {...props}
    />
  );
});

export const PagePanelContentArea = React.forwardRef<
  HTMLDivElement,
  PagePanelContentAreaProps
>(function PagePanelContentArea({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn("min-w-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
});
