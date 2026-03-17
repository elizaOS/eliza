import * as React from "react";
import { cn } from "../../lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "muted";

const STATUS_TONE_STYLES: Record<StatusTone, { badge: string; dot: string }> = {
  success: {
    badge: "text-ok border-ok/30 bg-ok/10",
    dot: "bg-ok",
  },
  warning: {
    badge: "text-warn border-warn/30 bg-warn/10",
    dot: "bg-warn",
  },
  danger: {
    badge: "text-destructive border-destructive/30 bg-destructive/10",
    dot: "bg-destructive",
  },
  muted: {
    badge: "text-muted border-border bg-bg",
    dot: "bg-muted",
  },
};

export function statusToneForBoolean(
  condition: boolean,
  onTone: StatusTone = "success",
  offTone: StatusTone = "muted",
): StatusTone {
  return condition ? onTone : offTone;
}

/* ── StatusBadge ─────────────────────────────────────────────────────── */

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  label: string;
  tone: StatusTone;
  withDot?: boolean;
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ label, tone, withDot = false, className, ...props }, ref) => {
    const styles = STATUS_TONE_STYLES[tone];
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase",
          styles.badge,
          className,
        )}
        {...props}
      >
        {withDot && (
          <span className={cn("h-1.5 w-1.5 rounded-full", styles.dot)} />
        )}
        {label}
      </span>
    );
  },
);
StatusBadge.displayName = "StatusBadge";

/* ── StatusDot ───────────────────────────────────────────────────────── */

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
}

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ status, className, ...props }, ref) => {
    const tone: StatusTone =
      status === "success" || status === "completed" || status === "connected"
        ? "success"
        : status === "error" || status === "failed" || status === "denied"
          ? "danger"
          : "muted";

    const styles = STATUS_TONE_STYLES[tone];
    return (
      <span
        ref={ref}
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          styles.dot,
          className,
        )}
        {...props}
      />
    );
  },
);
StatusDot.displayName = "StatusDot";

/* ── StatCard ────────────────────────────────────────────────────────── */

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}

export const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ label, value, accent = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center border border-border bg-bg p-3 min-w-[80px]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "text-lg font-bold tabular-nums",
          accent && "text-accent",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
        {label}
      </div>
    </div>
  ),
);
StatCard.displayName = "StatCard";
