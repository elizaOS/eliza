// Sibling primitive mirrored at cloud/packages/ui/src/components/status-badge.tsx. The two
// workspaces (Eliza-UI and Cloud-UI) cannot depend on each other today, so
// these files are intentional siblings. When changing behavior, props, or
// visual semantics, update both — or extract to a shared package per
// docs/frontend-cleanup-2026-05-12/15-cloud-eliza-primitive-dedup.md.
import * as React from "react";
import { cn } from "../../lib/utils";

export type StatusVariant = "success" | "warning" | "danger" | "muted";
export type StatusTone = StatusVariant;

export function statusToneForBoolean(
  condition: boolean,
  onTone: StatusVariant = "success",
  offTone: StatusVariant = "muted",
): StatusVariant {
  return condition ? onTone : offTone;
}

export function statusToneForState(status: string): StatusVariant {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "connected" ||
    normalized === "approved" ||
    normalized === "signed" ||
    normalized === "broadcast" ||
    normalized === "confirmed" ||
    normalized === "ready"
  ) {
    return "success";
  }
  if (normalized === "warning" || normalized === "pending") {
    return "warning";
  }
  if (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "denied" ||
    normalized === "rejected"
  ) {
    return "danger";
  }
  return "muted";
}

export function statusLabelForState(status: string): string {
  const normalized = status.trim().replace(/[_-]+/g, " ");
  if (!normalized) return status;
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  label: string;
  variant?: StatusVariant;
  tone?: StatusTone;
  withDot?: boolean;
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ label, variant, tone, withDot = false, className, ...props }, ref) => {
    const resolvedVariant = variant ?? tone ?? "muted";
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-2xs font-bold uppercase",
          resolvedVariant === "success"
            ? "border-ok/35 bg-ok/12 text-ok"
            : resolvedVariant === "warning"
              ? "border-warn/40 bg-warn/14 text-warn"
              : resolvedVariant === "danger"
                ? "border-destructive/35 bg-destructive/12 text-destructive"
                : "border-border bg-bg-accent text-muted-strong",
          className,
        )}
        {...props}
      >
        {withDot && (
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              resolvedVariant === "success"
                ? "bg-ok"
                : resolvedVariant === "warning"
                  ? "bg-warn"
                  : resolvedVariant === "danger"
                    ? "bg-destructive"
                    : "bg-muted",
            )}
          />
        )}
        {label}
      </span>
    );
  },
);
StatusBadge.displayName = "StatusBadge";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic status string — mapped to a variant internally. */
  status?: string;
  /** Direct variant override — when provided, `status` is ignored. */
  tone?: StatusVariant;
}

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ status, tone: toneProp, className, ...props }, ref) => {
    const variant: StatusVariant =
      toneProp ??
      (status === "success" || status === "completed" || status === "connected"
        ? "success"
        : status === "error" || status === "failed" || status === "denied"
          ? "danger"
          : "muted");

    return (
      <span
        ref={ref}
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          variant === "success"
            ? "bg-ok"
            : variant === "warning"
              ? "bg-warn"
              : variant === "danger"
                ? "bg-destructive"
                : "bg-muted",
          className,
        )}
        {...props}
      />
    );
  },
);
StatusDot.displayName = "StatusDot";
