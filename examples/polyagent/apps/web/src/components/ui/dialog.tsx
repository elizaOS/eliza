import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Dialog component for displaying modal dialogs.
 *
 * Provides a modal dialog overlay with backdrop. Closes when backdrop
 * is clicked or onOpenChange is called. Only renders when open is true.
 *
 * @param props - Dialog component props
 * @returns Dialog element or null if not open
 *
 * @example
 * ```tsx
 * <Dialog open={isOpen} onOpenChange={setIsOpen}>
 *   <DialogContent>...</DialogContent>
 * </Dialog>
 * ```
 */
export interface DialogProps extends React.ComponentPropsWithoutRef<"div"> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const Dialog = ({
  children,
  open,
  onOpenChange,
  className,
  ...props
}: DialogProps) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => onOpenChange?.(false)}
      />
      {/* Content Container */}
      <div className={cn("relative z-50", className)} {...props}>
        {children}
      </div>
    </div>
  );
};

/**
 * Dialog content container component.
 *
 * Wraps the dialog content with styling and prevents click propagation.
 * Includes fade-in and zoom-in animations.
 *
 * @param props - DialogContent component props
 * @returns Dialog content element
 */
export type DialogContentProps = React.ComponentPropsWithoutRef<"div">;

export const DialogContent = ({
  children,
  className,
  ...props
}: DialogContentProps) => {
  return (
    <div
      className={cn(
        "w-full rounded-lg border border-border bg-background shadow-lg",
        "fade-in-0 zoom-in-95 animate-in duration-200",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      {children}
    </div>
  );
};

/**
 * Dialog header container component.
 *
 * Provides layout for dialog title and description with responsive
 * text alignment (center on mobile, left on desktop).
 *
 * @param props - DialogHeader component props
 * @returns Dialog header element
 */
export type DialogHeaderProps = React.ComponentPropsWithoutRef<"div">;

export const DialogHeader = ({
  children,
  className,
  ...props
}: DialogHeaderProps) => {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

/**
 * Dialog title component.
 *
 * Displays the dialog title with semibold font and tight tracking.
 *
 * @param props - DialogTitle component props
 * @returns Dialog title element
 */
export type DialogTitleProps = React.ComponentPropsWithoutRef<"h2">;

export const DialogTitle = ({
  children,
  className,
  ...props
}: DialogTitleProps) => {
  return (
    <h2
      className={cn(
        "font-semibold text-lg leading-none tracking-tight",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
};

/**
 * Dialog description component.
 *
 * Displays dialog description text with muted foreground color.
 *
 * @param props - DialogDescription component props
 * @returns Dialog description element
 */
export type DialogDescriptionProps = React.ComponentPropsWithoutRef<"p">;

export const DialogDescription = ({
  children,
  className,
  ...props
}: DialogDescriptionProps) => {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props}>
      {children}
    </p>
  );
};

/**
 * Dialog footer container component.
 *
 * Provides layout for action buttons with responsive column/row
 * layout (column on mobile, row on desktop).
 *
 * @param props - DialogFooter component props
 * @returns Dialog footer element
 */
export type DialogFooterProps = React.ComponentPropsWithoutRef<"div">;

export const DialogFooter = ({
  children,
  className,
  ...props
}: DialogFooterProps) => {
  return (
    <div
      className={cn(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};
