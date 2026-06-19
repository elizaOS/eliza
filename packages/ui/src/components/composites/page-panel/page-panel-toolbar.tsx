import * as React from "react";

import { cn } from "../../../lib/utils";
import type { PagePanelToolbarProps } from "./page-panel-types";

export const PagePanelToolbar = React.forwardRef<
  HTMLDivElement,
  PagePanelToolbarProps
>(function PagePanelToolbar({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn("mb-4 flex flex-wrap items-center gap-3", className)}
      {...props}
    />
  );
});
