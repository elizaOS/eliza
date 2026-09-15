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
  PagePanelContentRailProps,
  PagePanelFrameProps,
} from "./page-panel-types";

export const PagePanelFrame = React.forwardRef<
  HTMLDivElement,
  PagePanelFrameProps
>(function PagePanelFrame({ className, ...props }, ref) {
  const { as, ...frameProps } = props;
  const Component = as ?? "div";
  return (
    <Card
      asChild
      variant="transparent"
      className={cn("flex h-full w-full min-h-0 p-0", className)}
    >
      <Component ref={ref as never} {...frameProps} />
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
      className={cn(
        "eliza-chat-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scroll-pb-[var(--view-pad-bottom)]",
        className,
      )}
      {...props}
    />
  );
});

/**
 * Centered responsive content rail for routed views. This deliberately does
 * not own vertical padding or scrolling: those vary between fixed-header,
 * split-workspace, and fullscreen surfaces. It centralizes the invariant
 * 16px mobile / 24px larger-screen horizontal rhythm instead.
 */
export const PagePanelContentRail = React.forwardRef<
  HTMLDivElement,
  PagePanelContentRailProps
>(function PagePanelContentRail(
  { className, width = "standard", ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="page-panel-content-rail"
      data-width={width}
      className={cn(
        "mx-auto w-full min-w-0 px-4 sm:px-6",
        width === "compact"
          ? "max-w-3xl"
          : width === "wide"
            ? "max-w-5xl"
            : "max-w-[820px]",
        className,
      )}
      {...props}
    />
  );
});
