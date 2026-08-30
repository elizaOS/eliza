/**
 * Centered placeholder for empty lists/views: optional icon, title,
 * description, and a primary action slot.
 */
import * as React from "react";
import { cn } from "../../lib/utils";
import { Card } from "./card";

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
    <Card
      ref={ref}
      variant={variant === "dashed" ? "dashed" : "transparent"}
      data-slot="empty-state"
      data-variant={variant}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant === "default" && "min-h-[400px] flex-1 gap-4 p-6",
        variant === "dashed" && "gap-4 p-8",
        variant === "minimal" && "gap-3 px-4 py-8",
        className,
      )}
      {...props}
    >
      {icon && (
        <Card variant="accentTile" className="size-14">
          {icon}
        </Card>
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
    </Card>
  ),
);
EmptyState.displayName = "EmptyState";
