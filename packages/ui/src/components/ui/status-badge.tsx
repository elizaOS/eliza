import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export type StatusVariant =
  | "success"
  | "warning"
  | "danger"
  | "error"
  | "info"
  | "neutral"
  | "processing"
  | "muted";
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
  status?: StatusVariant;
  variant?: StatusVariant;
  tone?: StatusTone;
  withDot?: boolean;
  pulse?: boolean;
  icon?: React.ReactNode;
}

function normalizeStatusVariant(variant: StatusVariant): StatusVariant {
  if (variant === "error") return "danger";
  if (variant === "neutral") return "muted";
  return variant;
}

function statusBadgeClasses(variant: StatusVariant): string {
  const normalized = normalizeStatusVariant(variant);
  if (normalized === "success") {
    return "border-ok/35 bg-ok/12 text-ok";
  }
  if (normalized === "warning" || normalized === "processing") {
    return "border-warn/40 bg-warn/14 text-warn";
  }
  if (normalized === "danger") {
    return "border-destructive/35 bg-destructive/12 text-destructive";
  }
  if (normalized === "info") {
    return "border-status-info/35 bg-status-info-bg text-status-info";
  }
  return "border-border bg-bg-accent text-muted-strong";
}

function statusDotClasses(variant: StatusVariant): string {
  const normalized = normalizeStatusVariant(variant);
  if (normalized === "success") return "bg-ok";
  if (normalized === "warning" || normalized === "processing") {
    return "bg-warn";
  }
  if (normalized === "danger") return "bg-destructive";
  if (normalized === "info") return "bg-status-info";
  return "bg-muted";
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  (
    {
      label,
      status,
      variant,
      tone,
      withDot = false,
      pulse = false,
      icon,
      className,
      ...props
    },
    ref,
  ) => {
    const resolvedVariant = status ?? variant ?? tone ?? "muted";
    const showDot = withDot || pulse;
    return (
      <span
        ref={ref}
        data-slot="status-badge"
        data-status={resolvedVariant}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-2xs font-bold uppercase",
          statusBadgeClasses(resolvedVariant),
          className,
        )}
        {...props}
      >
        {resolvedVariant === "processing" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : icon ? (
          <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
        ) : showDot ? (
          <span className="relative flex h-2 w-2">
            {pulse && (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full animate-ping rounded-full opacity-70",
                  statusDotClasses(resolvedVariant),
                )}
              />
            )}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                statusDotClasses(resolvedVariant),
              )}
            />
          </span>
        ) : null}
        <span>{label}</span>
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
    const variant = normalizeStatusVariant(
      toneProp ??
        (status === "success" ||
        status === "completed" ||
        status === "connected"
          ? "success"
          : status === "error" || status === "failed" || status === "denied"
            ? "danger"
            : "muted"),
    );

    return (
      <span
        ref={ref}
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          statusDotClasses(variant),
          className,
        )}
        {...props}
      />
    );
  },
);
StatusDot.displayName = "StatusDot";
