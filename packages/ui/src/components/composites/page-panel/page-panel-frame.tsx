/**
 * Full-height flex frame for a page and its scrollable content column:
 * `PagePanelFrame` is the outer full-bleed container, `PagePanelContentArea`
 * the scrolling main column inside it.
 */
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
import type {
  PagePanelContentAreaProps,
  PagePanelFrameProps,
} from "./page-panel-types";

export const PagePanelFrame = React.forwardRef<
  HTMLDivElement,
  PagePanelFrameProps
>(function PagePanelFrame({ className, ...props }, ref) {
  return (
    <Card
      asChild
      variant="transparent"
      className={cn("flex h-full w-full min-h-0 p-0", className)}
    >
      <div ref={ref} {...props} />
    </Card>
  );
});

export const PagePanelContentArea = React.forwardRef<
  HTMLDivElement,
  PagePanelContentAreaProps
>(function PagePanelContentArea({ className, tabIndex = 0, ...props }, ref) {
  return (
    <Card
      ref={ref}
      variant="transparentSquare"
      tabIndex={tabIndex}
      className={cn("min-w-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
});
