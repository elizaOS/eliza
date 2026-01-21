"use client";

import { cn } from "@polyagent/shared";
import type * as React from "react";

/**
 * Alert dialog component for displaying modal confirmations and alerts.
 *
 * Provides a modal dialog overlay with backdrop blur. Closes when backdrop
 * is clicked or onOpenChange is called. Only renders when open is true.
 *
 * @param props - AlertDialog component props
 * @returns Alert dialog element or null if not open
 *
 * @example
 * ```tsx
 * <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
 *   <AlertDialogContent>...</AlertDialogContent>
 * </AlertDialog>
 * ```
 */
interface AlertDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function AlertDialog({
  open,
  onOpenChange,
  children,
}: AlertDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => onOpenChange?.(false)}
      />
      {/* Content */}
      <div className="relative z-50">{children}</div>
    </div>
  );
}

/**
 * Alert dialog content container component.
 *
 * Wraps the dialog content with styling and prevents click propagation.
 * Includes fade-in and zoom-in animations.
 *
 * @param props - AlertDialogContent component props
 * @returns Alert dialog content element
 */
interface AlertDialogContentProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogContent({
  children,
  className,
}: AlertDialogContentProps) {
  return (
    <div
      className={cn(
        "mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg",
        "fade-in-0 zoom-in-95 animate-in duration-200",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * Alert dialog header container component.
 *
 * Provides layout for dialog title and description with responsive
 * text alignment (center on mobile, left on desktop).
 *
 * @param props - AlertDialogHeader component props
 * @returns Alert dialog header element
 */
interface AlertDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogHeader({
  children,
  className,
}: AlertDialogHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col space-y-2 text-center sm:text-left",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Alert dialog title component.
 *
 * Displays the dialog title with semibold font styling.
 *
 * @param props - AlertDialogTitle component props
 * @returns Alert dialog title element
 */
interface AlertDialogTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogTitle({
  children,
  className,
}: AlertDialogTitleProps) {
  return (
    <h2 className={cn("font-semibold text-foreground text-lg", className)}>
      {children}
    </h2>
  );
}

/**
 * Alert dialog description component.
 *
 * Displays dialog description text with muted foreground color.
 *
 * @param props - AlertDialogDescription component props
 * @returns Alert dialog description element
 */
interface AlertDialogDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogDescription({
  children,
  className,
}: AlertDialogDescriptionProps) {
  return (
    <div className={cn("text-muted-foreground text-sm", className)}>
      {children}
    </div>
  );
}

/**
 * Alert dialog footer container component.
 *
 * Provides layout for action buttons with responsive column/row
 * layout (column on mobile, row on desktop).
 *
 * @param props - AlertDialogFooter component props
 * @returns Alert dialog footer element
 */
interface AlertDialogFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogFooter({
  children,
  className,
}: AlertDialogFooterProps) {
  return (
    <div
      className={cn(
        "mt-4 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Alert dialog action button component.
 *
 * Primary action button for alert dialogs with primary styling.
 * Extends standard button HTML attributes.
 *
 * @param props - AlertDialogAction component props
 * @returns Alert dialog action button element
 */
interface AlertDialogActionProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogAction({
  children,
  className,
  ...props
}: AlertDialogActionProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium text-sm",
        "h-10 px-4 py-2",
        "bg-primary text-primary-foreground hover:bg-primary/90",
        "disabled:pointer-events-none disabled:opacity-50",
        "transition-colors",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Alert dialog cancel button component.
 *
 * Secondary/cancel action button for alert dialogs with outline styling.
 * Extends standard button HTML attributes.
 *
 * @param props - AlertDialogCancel component props
 * @returns Alert dialog cancel button element
 */
interface AlertDialogCancelProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogCancel({
  children,
  className,
  ...props
}: AlertDialogCancelProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium text-sm",
        "mt-2 h-10 px-4 py-2 sm:mt-0",
        "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        "transition-colors",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
