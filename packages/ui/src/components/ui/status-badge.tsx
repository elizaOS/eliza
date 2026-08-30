/**
 * Small status pill in one of a fixed tone set (success/warning/danger/…), with
 * a spinning variant for in-flight states. Tone/label derivation from raw status
 * strings lives in `status-badge.helpers.ts`.
 */
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Badge } from "./badge";

export type StatusVariant =
  | "success"
  | "warning"
  | "danger"
  | "error"
  | "info"
  | "neutral"
  | "processing"
  | "muted"
  | "accent";
export type StatusTone = StatusVariant;

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  label: React.ReactNode;
  status?: StatusVariant;
  variant?: StatusVariant;
  tone?: StatusTone;
  withDot?: boolean;
  pulse?: boolean;
  icon?: React.ReactNode;
  presentation?: "default" | "pill";
}

function normalizeStatusVariant(variant: StatusVariant): StatusVariant {
  if (variant === "error") return "danger";
  if (variant === "neutral") return "muted";
  return variant;
}

function statusBadgeVariant(
  variant: StatusVariant,
):
  | "statusSuccess"
  | "statusWarning"
  | "statusDanger"
  | "statusInfo"
  | "statusMuted" {
  const normalized = normalizeStatusVariant(variant);
  if (normalized === "success") return "statusSuccess";
  if (normalized === "warning" || normalized === "processing") {
    return "statusWarning";
  }
  if (normalized === "danger") return "statusDanger";
  if (normalized === "info" || normalized === "accent") return "statusInfo";
  return "statusMuted";
}

function statusDotClasses(variant: StatusVariant): string {
  const normalized = normalizeStatusVariant(variant);
  if (normalized === "success") return "bg-ok";
  if (normalized === "warning" || normalized === "processing") {
    return "bg-warn";
  }
  if (normalized === "danger") return "bg-destructive";
  if (normalized === "info") return "bg-status-info";
  if (normalized === "accent") return "bg-accent";
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
      presentation = "default",
      className,
      ...props
    },
    ref,
  ) => {
    const resolvedVariant = status ?? variant ?? tone ?? "muted";
    const showDot = withDot || pulse;
    return (
      <Badge
        asChild
        variant={statusBadgeVariant(resolvedVariant)}
        size={presentation === "pill" ? "pill" : "compact"}
      >
        <span
          ref={ref}
          data-slot="status-badge"
          data-status={resolvedVariant}
          className={cn("gap-1 font-bold", className)}
          {...props}
        >
          {resolvedVariant === "processing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : icon ? (
            <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
          ) : showDot ? (
            <StatusPulseDot tone={resolvedVariant} pulse={pulse} />
          ) : null}
          <span>{label}</span>
        </span>
      </Badge>
    );
  },
);
StatusBadge.displayName = "StatusBadge";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic status string — mapped to a variant internally. */
  status?: string;
  /** Direct variant override — when provided, `status` is ignored. */
  tone?: StatusVariant;
  size?: "default" | "compact";
  color?: string;
}

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  (
    {
      status,
      tone: toneProp,
      size = "default",
      color,
      className,
      style,
      ...props
    },
    ref,
  ) => {
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
          "inline-block size-2 rounded-full",
          size === "compact" && "size-1.5",
          statusDotClasses(variant),
          className,
        )}
        style={color ? { backgroundColor: color, ...style } : style}
        {...props}
      />
    );
  },
);
StatusDot.displayName = "StatusDot";

interface StatusPulseDotProps {
  pulse: boolean;
  size?: "default" | "micro";
  tone: StatusVariant;
}

export function StatusPulseDot({
  pulse,
  size = "default",
  tone,
}: StatusPulseDotProps) {
  return (
    <span
      className={cn("relative flex", size === "micro" ? "size-1.5" : "size-2")}
    >
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-70",
            statusDotClasses(tone),
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          statusDotClasses(tone),
        )}
      />
    </span>
  );
}
