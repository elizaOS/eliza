/**
 * The primitive parts a sidebar body is composed from: section labels/headers,
 * empty/notice states, toolbars, and the row primitives (item, icon, body,
 * title, description, action) plus the collapsed-rail item variant. Each part
 * is exported individually and bundled under the `SidebarContent` namespace
 * object so callers can write `SidebarContent.Item`; higher-level pieces
 * (skill-sidebar-item, the sidebar root) build on these.
 */
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { StatusDot } from "../../ui/status-badge";

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

export interface SidebarSectionLabelProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SidebarSectionLabel({
  className,
  ...props
}: SidebarSectionLabelProps) {
  return (
    <div
      data-sidebar-section-label
      className={cn(
        "text-xs-tight font-semibold uppercase tracking-[0.16em] text-txt-strong",
        className,
      )}
      {...props}
    />
  );
}

export interface SidebarSectionHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  meta?: React.ReactNode;
}

export function SidebarSectionHeader({
  className,
  meta,
  children,
  ...props
}: SidebarSectionHeaderProps) {
  return (
    <div
      data-sidebar-section-header
      className={cn("mb-2 flex items-center justify-between gap-2", className)}
      {...props}
    >
      {children}
      {meta ? <div className="text-2xs text-muted/50">{meta}</div> : null}
    </div>
  );
}

export interface SidebarEmptyStateProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "game-modal";
}

export function SidebarEmptyState({
  variant = "default",
  className,
  ...props
}: SidebarEmptyStateProps) {
  return (
    <Card
      asChild
      surface="backgroundSubtle"
      padding="comfortable"
      tone="muted"
      data-sidebar-empty-state
      className={cn(
        "py-8 text-center text-sm",
        variant === "game-modal" && "font-medium italic",
        className,
      )}
    >
      <div {...props} />
    </Card>
  );
}

export interface SidebarNoticeProps
  extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "danger";
  icon?: React.ReactNode;
}

export function SidebarNotice({
  tone = "default",
  icon,
  className,
  children,
  ...props
}: SidebarNoticeProps) {
  return (
    <Alert
      data-sidebar-notice
      variant={tone === "danger" ? "sidebarDanger" : "sidebar"}
      className={cn("flex items-center gap-2 p-3 text-sm", className)}
      {...props}
    >
      {icon}
      {children}
    </Alert>
  );
}

export interface SidebarToolbarProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SidebarToolbar({ className, ...props }: SidebarToolbarProps) {
  return (
    <div
      data-sidebar-toolbar
      className={cn("flex w-full min-w-0 items-center gap-2", className)}
      {...props}
    />
  );
}

export interface SidebarToolbarPrimaryProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SidebarToolbarPrimary({
  className,
  ...props
}: SidebarToolbarPrimaryProps) {
  return (
    <div
      data-sidebar-toolbar-primary
      className={cn("min-w-0 flex-1", className)}
      {...props}
    />
  );
}

export interface SidebarToolbarActionsProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SidebarToolbarActions({
  className,
  ...props
}: SidebarToolbarActionsProps) {
  return (
    <div
      data-sidebar-toolbar-actions
      className={cn("flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
}

export interface SidebarItemProps extends React.HTMLAttributes<HTMLElement> {
  active?: boolean;
  as?: "button" | "div";
  variant?: "default" | "accent-soft" | "dashed";
}

export const SidebarItem = React.forwardRef<HTMLElement, SidebarItemProps>(
  function SidebarItem(
    { active = false, as = "button", variant = "default", className, ...props },
    ref,
  ) {
    const sharedLayoutClassName =
      "group flex h-auto w-full min-w-0 items-start justify-start gap-3 px-3.5 py-3 text-left transition-[background-color,color,box-shadow,transform] duration-150";
    if (as === "div") {
      return (
        <Card
          asChild
          variant={
            active
              ? "sidebarItemActive"
              : variant === "dashed"
                ? "dashed"
                : undefined
          }
          surface={
            !active && variant === "accent-soft"
              ? "accentSubtle"
              : !active && variant === "default"
                ? "transparent"
                : undefined
          }
          tone={!active && variant === "accent-soft" ? "muted" : undefined}
          border={!active && variant === "accent-soft" ? "accent" : undefined}
        >
          <div
            ref={(node) => assignRef(ref, node)}
            data-sidebar-item
            className={cn(sharedLayoutClassName, className)}
            {...props}
          />
        </Card>
      );
    }

    return (
      <Button
        ref={(node) => assignRef(ref, node)}
        variant={
          active
            ? "selection"
            : variant === "accent-soft"
              ? "surfaceAccent"
              : variant === "dashed"
                ? "outline"
                : "ghostMuted"
        }
        size="eventRow"
        data-state={active ? "on" : "off"}
        data-sidebar-item
        className={className}
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      />
    );
  },
);

export interface SidebarItemIconProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
}

export function SidebarItemIcon({
  active = false,
  className,
  ...props
}: SidebarItemIconProps) {
  return (
    <Card
      asChild
      variant={active ? "sidebarIconActive" : "sidebarIcon"}
      tone={active ? "strong" : undefined}
      data-sidebar-item-icon
      className={cn(
        "mt-0.5 flex size-10 shrink-0 items-center justify-center p-2",
        className,
      )}
    >
      <span {...props} />
    </Card>
  );
}

export interface SidebarItemBodyProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function SidebarItemBody({ className, ...props }: SidebarItemBodyProps) {
  return (
    <span
      data-sidebar-item-body
      className={cn("min-w-0 flex-1 text-left", className)}
      {...props}
    />
  );
}

export interface SidebarItemButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const SidebarItemButton = React.forwardRef<
  HTMLButtonElement,
  SidebarItemButtonProps
>(function SidebarItemButton({ className, ...props }, ref) {
  return (
    <Card asChild variant="sidebarRail">
      <Button
        ref={ref}
        variant="transparent"
        size="rowContent"
        align="start"
        data-sidebar-item-button
        className={cn(
          "flex min-w-0 flex-1 self-stretch items-start",
          className,
        )}
        {...props}
      />
    </Card>
  );
});

export interface SidebarItemTitleProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function SidebarItemTitle({
  className,
  ...props
}: SidebarItemTitleProps) {
  return (
    <span
      data-sidebar-item-title
      className={cn(
        "block whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-semibold leading-snug text-inherit",
        className,
      )}
      {...props}
    />
  );
}

export interface SidebarItemDescriptionProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function SidebarItemDescription({
  className,
  ...props
}: SidebarItemDescriptionProps) {
  return (
    <span
      data-sidebar-item-description
      className={cn(
        "mt-1 block whitespace-normal break-words [overflow-wrap:anywhere] text-xs-tight leading-relaxed text-muted/85",
        className,
      )}
      {...props}
    />
  );
}

export interface SidebarRailItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  indicatorTone?: "accent" | "muted";
}

export interface SidebarRailMediaProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function SidebarRailMedia({
  className,
  ...props
}: SidebarRailMediaProps) {
  return (
    <span
      data-sidebar-rail-media
      className={cn(
        "inline-flex items-center justify-center leading-none text-sm [&_img]:h-4 [&_img]:w-4 [&_img]:object-contain [&_img]:rounded-none [&_svg]:h-4 [&_svg]:w-4",
        className,
      )}
      {...props}
    />
  );
}

export const SidebarRailItem = React.forwardRef<
  HTMLButtonElement,
  SidebarRailItemProps
>(function SidebarRailItem(
  { active = false, indicatorTone, className, children, ...props },
  ref,
) {
  return (
    <Card asChild variant="sidebarRail">
      <Button
        ref={ref}
        variant="transparent"
        size="icon-lg"
        data-state={active ? "on" : "off"}
        data-sidebar-rail-item
        className={cn(
          "relative shrink-0 text-xs font-semibold tracking-[0.02em] transition-[border-color,background-color,color,box-shadow,transform] duration-150 active:scale-[0.98]",
          className,
        )}
        {...props}
      >
        <span className="inline-flex items-center justify-center truncate px-1 [&_img]:h-4 [&_img]:w-4 [&_svg]:h-4 [&_svg]:w-4">
          {children}
        </span>
        {indicatorTone ? (
          <StatusDot
            tone={indicatorTone === "accent" ? "accent" : "muted"}
            className="absolute right-1.5 top-1.5 size-2"
          />
        ) : null}
      </Button>
    </Card>
  );
});

export interface SidebarItemActionProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export function SidebarItemAction({
  className,
  ...props
}: SidebarItemActionProps) {
  return (
    <Button
      variant="dangerGhost"
      size="micro"
      data-sidebar-item-action
      className={cn(
        "absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export const SidebarContent = {
  EmptyState: SidebarEmptyState,
  ItemBody: SidebarItemBody,
  ItemDescription: SidebarItemDescription,
  ItemIcon: SidebarItemIcon,
  ItemAction: SidebarItemAction,
  ItemButton: SidebarItemButton,
  ItemTitle: SidebarItemTitle,
  Toolbar: SidebarToolbar,
  ToolbarPrimary: SidebarToolbarPrimary,
  ToolbarActions: SidebarToolbarActions,
  SectionLabel: SidebarSectionLabel,
  SectionHeader: SidebarSectionHeader,
  Notice: SidebarNotice,
  Item: SidebarItem,
  RailMedia: SidebarRailMedia,
  RailItem: SidebarRailItem,
};
