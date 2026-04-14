import type * as React from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  sidebarCollapsedActionButtonClassName,
  sidebarCollapsedRailActionWrapClassName,
  sidebarCollapsedRailListClassName,
  sidebarCollapsedRailRootClassName,
} from "./sidebar-styles";

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
