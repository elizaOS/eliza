/**
 * Alert component for displaying important messages.
 * Supports default and destructive variants with icon support.
 */

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-sm border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-txt",
        warning: "border-warn/30 bg-warn/5 text-txt",
        destructive:
          "border-destructive/30 bg-destructive-subtle text-destructive [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90",
        sidebar: "border-border/40 bg-bg/35 text-muted",
        sidebarDanger: "border-danger/30 bg-danger/10 text-danger",
        inlineDanger:
          "block border-danger/35 bg-danger/10 p-2.5 font-mono text-xs text-danger",
        inlineDangerCompact:
          "block border-danger/35 bg-danger/10 p-2 font-mono text-xs text-danger",
        warningStrong: "border-warn/30 bg-warn/10 text-txt",
        warningDiff: "border-warn/30 bg-warn/5 text-xs text-warning",
        warningCompact:
          "border-warn/30 bg-warn/10 px-3 py-1.5 text-2xs text-warn",
        dashboardInfo:
          "border-status-info/35 bg-status-info-bg text-status-info",
        dashboardSuccess:
          "border-status-success/30 bg-status-success-bg text-status-success",
        dashboardWarning:
          "border-status-warning/30 bg-status-warning-bg text-status-warning",
        dashboardError:
          "border-destructive/40 bg-destructive-subtle text-destructive",
        dangerConfirm: "border-danger/50 bg-destructive-subtle text-danger",
        inlineDestructive:
          "rounded-sm border border-destructive/40 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
