/**
 * Determinate progress bar over Radix `@radix-ui/react-progress`, themed to the
 * kit tokens. Derived from shadcn/ui `progress`
 * (https://ui.shadcn.com/docs/components/progress).
 */
"use client";

import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";

import { cn } from "../../lib/utils";

function Progress({
  className,
  value,
  variant = "default",
  tone = "primary",
  "aria-label": ariaLabel = "Progress",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  variant?: "default" | "milestone" | "usage";
  tone?: "primary" | "foreground" | "success" | "warning" | "danger" | "muted";
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      aria-label={ariaLabel}
      value={value}
      className={cn(
        "relative h-2.5 w-full overflow-hidden rounded-sm border border-border bg-bg-accent",
        variant === "milestone" &&
          "h-1.5 rounded-full border-0 bg-white/10 [&_[data-slot=progress-indicator]]:rounded-full [&_[data-slot=progress-indicator]]:duration-700",
        variant === "usage" &&
          "h-1.5 min-w-[48px] flex-1 rounded-full border-0 bg-bg-accent",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full flex-1 bg-primary transition-all",
          tone === "foreground" && "bg-txt",
          tone === "success" && "bg-status-success",
          tone === "warning" && "bg-warn",
          tone === "danger" && "bg-destructive",
          tone === "muted" && "bg-muted/30",
        )}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
