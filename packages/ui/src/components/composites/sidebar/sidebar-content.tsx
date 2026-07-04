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
import { Button } from "../../ui/button";
import { navActiveClassVertical } from "./nav-active";

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
    <div
      data-sidebar-empty-state
      className={cn(
        "rounded-sm px-4 py-8 text-center text-sm",
        variant === "game-modal"
          ? "bg-black/15 font-medium italic text-[color:var(--first-run-text-muted)]"
          : "bg-bg-muted/50 text-muted",
        className,
      )}
      {...props}
    />
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
    <div
      data-sidebar-notice
      className={cn(
        "flex items-center gap-2 rounded-sm border px-3 py-3 text-sm",
        tone === "danger"
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-border/40 bg-bg/35 text-muted",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </div>
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
    const sharedClassName = cn(
      "group flex h-auto w-full min-w-0 items-start justify-start gap-3 rounded-sm px-3.5 py-3 text-left transition-[background-color,color,box-shadow,transform] duration-150   ",
      active
        ? navActiveClassVertical
        : variant === "accent-soft"
          ? "bg-accent/5 text-muted hover:bg-accent/10 hover:text-txt"
          : variant === "dashed"
            ? "border border-dashed border-border/40 text-muted hover:border-border hover:bg-bg-hover hover:text-txt"
            : "text-muted hover:bg-bg-hover hover:text-txt",
      className,
    );

    if (as === "div") {
      return (
        <div
          ref={(node) => assignRef(ref, node)}
          data-sidebar-item
          className={sharedClassName}
          {...props}
        />
      );
    }

    return (
      <Button
        ref={(node) => assignRef(ref, node)}
        variant="ghost"
        data-sidebar-item
        className={sharedClassName}
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
    <span
      data-sidebar-item-icon
      className={cn(
        "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-sm p-2",
        active ? "bg-accent/18 text-txt-strong" : "bg-bg-accent/80 text-muted",
        className,
      )}
      {...props}
    />
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
    <Button
      ref={ref}
      variant="ghost"
      data-sidebar-item-button
      className={cn(
        "flex h-auto min-w-0 flex-1 self-stretch items-start justify-start gap-3 rounded-none p-0 text-left font-normal hover:bg-transparent",
        className,
      )}
      {...props}
    />
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
    <Button
      ref={ref}
      variant="ghost"
      size="icon-lg"
      data-sidebar-rail-item
      className={cn(
        "relative h-11 w-11 shrink-0 rounded-sm border border-border/24 p-0 text-xs font-semibold tracking-[0.02em] transition-[border-color,background-color,color,box-shadow,transform] duration-150 active:scale-[0.98]",
        active
          ? navActiveClassVertical
          : "bg-card text-muted-strong hover:border-border/38 hover:text-txt ",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-center justify-center truncate px-1 [&_img]:h-4 [&_img]:w-4 [&_svg]:h-4 [&_svg]:w-4">
        {children}
      </span>
      {indicatorTone ? (
        <span
          className={cn(
            "absolute right-1.5 top-1.5 h-2 w-2 rounded-full",
            indicatorTone === "accent" ? "bg-accent" : "bg-muted/70",
          )}
        />
      ) : null}
    </Button>
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
      variant="ghost"
      data-sidebar-item-action
      className={cn(
        "absolute right-1.5 top-1.5 h-auto rounded-sm bg-bg/80 px-1.5 py-0.5 text-2xs text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger",
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
