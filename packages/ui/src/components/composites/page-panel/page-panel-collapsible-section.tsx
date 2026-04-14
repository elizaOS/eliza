import * as React from "react";

import { cn } from "../../../lib/utils";
import { PanelHeader } from "./page-panel-header";
import { PagePanelRoot } from "./page-panel-root";
import type { PagePanelCollapsibleSectionProps } from "./page-panel-types";

export const PagePanelCollapsibleSection = React.forwardRef<
  HTMLElement,
  PagePanelCollapsibleSectionProps
>(function PagePanelCollapsibleSection(
  {
    actions,
    as = "section",
    bodyClassName,
    bordered = true,
    children,
    className,
    defaultExpanded = false,
    description,
    descriptionClassName,
    expandOnCollapsedSurfaceClick = false,
    expanded,
    heading,
    headingClassName,
    headerContentClassName,
    media,
    onClick,
    onExpandedChange,
    onKeyDown,
    role,
    tabIndex,
    variant = "section",
    ...props
  },
  ref,
) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    React.useState(defaultExpanded);
  const isExpanded = expanded ?? uncontrolledExpanded;
  const isControlled = expanded !== undefined;
  const isPanelActionTarget = React.useCallback(
    (target: EventTarget | null) => {
      return (
        target instanceof Element &&
        target.closest("[data-page-panel-actions='true']") !== null
      );
    },
    [],
  );

  const setExpanded = React.useCallback(
    (nextExpanded: boolean) => {
      if (!isControlled) {
        setUncontrolledExpanded(nextExpanded);
      }
      onExpandedChange?.(nextExpanded);
    },
    [isControlled, onExpandedChange],
  );

  const handleSurfaceClick = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (isPanelActionTarget(event.target)) return;
      if (!expandOnCollapsedSurfaceClick || isExpanded) return;
      setExpanded(true);
    },
    [
      expandOnCollapsedSurfaceClick,
      isExpanded,
      isPanelActionTarget,
      onClick,
      setExpanded,
    ],
  );

  const handleSurfaceKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (isPanelActionTarget(event.target)) return;
      if (!expandOnCollapsedSurfaceClick || isExpanded) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setExpanded(true);
      }
    },
    [
      expandOnCollapsedSurfaceClick,
      isExpanded,
      isPanelActionTarget,
      onKeyDown,
      setExpanded,
    ],
  );

  return (
    <PagePanelRoot
      ref={ref as React.Ref<HTMLDivElement>}
      as={as as never}
      variant={variant}
      aria-expanded={isExpanded}
      data-content-align-offset={4}
      className={cn(
        expandOnCollapsedSurfaceClick &&
          !isExpanded &&
          "cursor-pointer transition-[border-color,box-shadow,transform] hover:border-border/60 hover:shadow-[0_20px_36px_rgba(3,5,10,0.18)]",
        className,
      )}
      onClick={handleSurfaceClick}
      onKeyDown={handleSurfaceKeyDown}
      role={
        expandOnCollapsedSurfaceClick && !isExpanded ? (role ?? "button") : role
      }
      tabIndex={
        expandOnCollapsedSurfaceClick && !isExpanded
          ? (tabIndex ?? 0)
          : tabIndex
      }
      {...props}
    >
      <PanelHeader
        media={media}
        heading={heading}
        headingClassName={headingClassName}
        description={description}
        descriptionClassName={descriptionClassName}
        contentClassName={headerContentClassName}
        actions={
          actions ? (
            <div
              className="inline-flex items-center gap-2.5"
              data-page-panel-actions="true"
            >
              {actions}
            </div>
          ) : null
        }
        bordered={isExpanded && bordered}
      />
      {isExpanded ? (
        <div className={cn("px-4 pb-4 pt-1 sm:px-5 sm:pb-5", bodyClassName)}>
          {children}
        </div>
      ) : null}
    </PagePanelRoot>
  );
});
