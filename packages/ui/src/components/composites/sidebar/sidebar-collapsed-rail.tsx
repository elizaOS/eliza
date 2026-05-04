import type * as React from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

const sidebarCollapsedRailRootClassName =
  "flex min-h-0 w-full flex-1 flex-col items-center";

const sidebarCollapsedRailActionWrapClassName =
  "flex flex-col items-center gap-3 py-1";

const sidebarCollapsedRailListClassName =
  "custom-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-1 pb-2";

const sidebarCollapsedActionButtonClassName = "h-11 w-11 rounded-sm";

export interface SidebarCollapsedRailProps
  extends React.HTMLAttributes<HTMLDivElement> {
  action?: React.ReactNode;
  listClassName?: string;
}

export function SidebarCollapsedRail({
  action,
  children,
  className,
  listClassName,
  ...props
}: SidebarCollapsedRailProps) {
  return (
    <div
      data-sidebar-collapsed-rail
      className={cn(sidebarCollapsedRailRootClassName, className)}
      {...props}
    >
      {action ? (
        <div
          data-sidebar-collapsed-rail-action-wrap
          className={sidebarCollapsedRailActionWrapClassName}
        >
          {action}
          <div
            data-sidebar-collapsed-rail-list
            className={cn(
              sidebarCollapsedRailListClassName,
              "mt-1",
              listClassName,
            )}
          >
            {children}
          </div>
        </div>
      ) : (
        <div
          data-sidebar-collapsed-rail-list
          className={cn(
            sidebarCollapsedRailListClassName,
            "pt-1",
            listClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface SidebarCollapsedActionButtonProps
  extends React.ComponentProps<typeof Button> {}

export function SidebarCollapsedActionButton({
  className,
  size = "icon",
  variant = "surfaceAccent",
  ...props
}: SidebarCollapsedActionButtonProps) {
  return (
    <Button
      size={size}
      variant={variant}
      className={cn(sidebarCollapsedActionButtonClassName, className)}
      {...props}
    />
  );
}
