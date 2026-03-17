/**
 * Shared UI primitives for compact labels, pills, and status dots.
 */

import type { ReactNode } from "react";

type StatusTone = "success" | "warning" | "danger" | "muted";

type StatusToneStyles = {
  badge: string;
  dot: string;
};

const STATUS_TONES: Record<StatusTone, StatusToneStyles> = {
  success: {
    badge:
      "text-[var(--ok,#16a34a)] border border-[var(--ok,#16a34a)]/30 bg-[var(--ok,#16a34a)]/10",
    dot: "bg-[var(--ok,#16a34a)]",
  },
  warning: {
    badge: "text-[#f59e0b] border border-[#f59e0b]/30 bg-[#f59e0b]/10",
    dot: "bg-[#f59e0b]",
  },
  danger: {
    badge: "text-[#e74c3c] border border-[#e74c3c]/30 bg-[#e74c3c]/10",
    dot: "bg-[#e74c3c]",
  },
  muted: {
    badge: "text-[var(--muted)] border border-[var(--border)] bg-[var(--bg)]",
    dot: "bg-[var(--muted)]",
  },
};

export function statusToneForBoolean(
  condition: boolean,
  onTone: StatusTone = "success",
  offTone: StatusTone = "muted",
): StatusTone {
  return condition ? onTone : offTone;
}

export function StatusBadge({
  label,
  tone,
  withDot = false,
  className = "",
}: {
  label: string;
  tone: StatusTone;
  withDot?: boolean;
  className?: string;
}) {
  const toneStyles = STATUS_TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase ${toneStyles.badge} ${className}`}
    >
      {withDot && (
        <span className={`w-1.5 h-1.5 rounded-full ${toneStyles.dot}`} />
      )}
      {label}
    </span>
  );
}

export function StatusDot({
  status,
  className = "",
}: {
  status: string;
  className?: string;
}) {
  const tone =
    status === "success" || status === "completed" || status === "connected"
      ? "success"
      : status === "error" || status === "failed" || status === "denied"
        ? "danger"
        : "muted";

  const toneStyles = STATUS_TONES[tone];
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${toneStyles.dot} ${className}`}
    />
  );
}

export function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-3 border border-[var(--border)] bg-[var(--bg)] min-w-[80px]">
      <div
        className={`text-lg font-bold tabular-nums ${accent ? "text-txt" : ""}`}
      >
        {value}
      </div>
      <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mt-0.5">
        {label}
      </div>
    </div>
  );
}
