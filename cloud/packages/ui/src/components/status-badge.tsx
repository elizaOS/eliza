/**
 * Status badge component with semantic color variants.
 * Replaces 10+ inline status badge patterns across the app.
 */
"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

type StatusBadgeVariant = "success" | "warning" | "error" | "info" | "neutral" | "processing";

const variantStyles: Record<StatusBadgeVariant, string> = {
  success: "bg-green-500/10 text-green-500 border-green-500/20",
  warning: "border-amber-500/50 bg-amber-500/5 text-amber-500",
  error: "bg-red-500/10 text-red-500 border-red-500/20",
  info: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  neutral: "bg-white/5 text-white/60 border-white/10",
  processing: "border-amber-500/50 bg-amber-500/5 text-amber-500",
};

interface StatusBadgeProps {
  /** Semantic status variant */
  status: StatusBadgeVariant;
  /** Badge label text */
  label: string;
  /** Optional icon element (rendered before label) */
  icon?: React.ReactNode;
  /** Show a pulsing dot indicator */
  pulse?: boolean;
  /** Additional CSS classes */
  className?: string;
}

function StatusBadge({ status, label, icon, pulse, className }: StatusBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-none border px-2.5 py-0.5 text-xs font-medium transition-colors",
        variantStyles[status],
        className,
      )}
    >
      {status === "processing" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : icon ? (
        <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
      ) : pulse ? (
        <span className="relative flex h-2 w-2">
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              status === "success" && "bg-green-400",
              status === "warning" && "bg-amber-400",
              status === "error" && "bg-red-400",
              status === "info" && "bg-blue-400",
              status === "neutral" && "bg-white/40",
            )}
          />
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              status === "success" && "bg-green-500",
              status === "warning" && "bg-amber-500",
              status === "error" && "bg-red-500",
              status === "info" && "bg-blue-500",
              status === "neutral" && "bg-white/60",
            )}
          />
        </span>
      ) : null}
      {label}
    </span>
  );
}

export type { StatusBadgeProps, StatusBadgeVariant };
export { StatusBadge };
