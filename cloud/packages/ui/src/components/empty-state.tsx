/**
 * Empty state component for displaying when a section has no content.
 * Supports icon, title, description, action button, and custom children.
 */
"use client";

import * as React from "react";
import { cn } from "../lib/utils";

interface EmptyStateProps {
  /** Icon element displayed above the title */
  icon?: React.ReactNode;
  /** Primary heading text */
  title: string;
  /** Optional description text below the title */
  description?: string;
  /** Optional CTA button or action element */
  action?: React.ReactNode;
  /** Custom content rendered below the description (e.g. CLI commands) */
  children?: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Visual variant */
  variant?: "default" | "dashed" | "minimal";
}

function EmptyState({
  icon,
  title,
  description,
  action,
  children,
  className,
  variant = "default",
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center gap-4",
        variant === "default" && "min-h-[400px] px-4 py-12",
        variant === "dashed" &&
          "rounded-none border border-dashed border-white/10 bg-black/20 p-8 hover:border-[#FF5800]/30 transition-colors duration-300",
        variant === "minimal" && "py-8 px-4",
        className,
      )}
    >
      {icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#FF580020] border border-[#FF5800]/40">
          {icon}
        </div>
      )}
      <div className="space-y-2">
        <h3
          className={cn(
            "font-medium text-white",
            variant === "dashed" ? "text-sm text-white/50" : "text-lg",
          )}
        >
          {title}
        </h3>
        {description && <p className="max-w-sm text-sm text-white/60">{description}</p>}
      </div>
      {children}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export type { EmptyStateProps };
export { EmptyState };
