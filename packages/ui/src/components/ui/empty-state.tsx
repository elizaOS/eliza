import * as React from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Icon element rendered above the title */
  icon?: React.ReactNode;
  /** Main heading */
  title: string;
  /** Supporting description text */
  description?: string;
  /** Primary action button or element */
  action?: React.ReactNode;
  /** Visual density and framing. */
  variant?: "default" | "dashed" | "minimal";
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      icon,
      title,
      description,
      action,
      variant = "default",
      className,
      children,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      data-slot="empty-state"
      data-variant={variant}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant === "default" && "min-h-[400px] flex-1 gap-4 p-6",
        variant === "dashed" &&
          "gap-4 border border-dashed border-border bg-bg/40 p-8 transition-colors hover:border-accent/40",
        variant === "minimal" && "gap-3 px-4 py-8",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          {icon}
        </div>
      )}
      <div className="space-y-2">
        <h3
          className={cn(
            "font-semibold text-txt-strong",
            variant === "dashed" ? "text-sm" : "text-lg",
          )}
        >
          {title}
        </h3>
        {description && (
          <p className="max-w-sm text-sm text-muted">{description}</p>
        )}
      </div>
      {action}
      {children}
    </div>
  ),
);
EmptyState.displayName = "EmptyState";
