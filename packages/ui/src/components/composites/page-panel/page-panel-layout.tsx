import * as React from "react";
import { cn } from "../../../utils/cn";
import { Card } from "../../ui/card";
import type {
  PagePanelContentAreaProps,
  PagePanelContentRailProps,
  PagePanelFrameProps,
  PagePanelProps,
  PagePanelToolbarProps,
} from "./page-panel-types";

export const PagePanelRoot = React.forwardRef<HTMLDivElement, PagePanelProps>(
  function PagePanelRoot(
    { as, className, variant = "surface", ...props },
    ref,
  ) {
    const Component = as ?? "div";

    return (
      <Card
        asChild
        variant="transparent"
        className={cn(
          variant === "surface"
            ? "w-full"
            : variant === "workspace"
              ? "flex min-h-[58vh] flex-col overflow-hidden"
              : variant === "section"
                ? "w-full overflow-visible"
                : variant === "padded"
                  ? "px-4 py-3 sm:px-5 sm:py-4"
                  : variant === "shell"
                    ? "relative flex min-h-0 flex-1 overflow-hidden"
                    : undefined,
          className,
        )}
      >
        <Component ref={ref as never} {...props} />
      </Card>
    );
  },
);

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
