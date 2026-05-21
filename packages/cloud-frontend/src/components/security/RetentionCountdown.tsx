import { Clock } from "lucide-react";

interface RetentionCountdownProps {
  /** Epoch-ms at which the data expires / is purged. */
  until: number;
  now?: number;
  className?: string;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `expires in ${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2) return `expires in ${hours}h`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1) return `expires in ${minutes}m`;
  return "expires in <1m";
}

/**
 * Compact retention pill — used on trajectory rows and any other surface that
 * shows a soft-delete countdown. Rendering is intentionally pure; the parent
 * is responsible for picking a refresh cadence if it wants live updates.
 */
export function RetentionCountdown({
  until,
  now = Date.now(),
  className,
}: RetentionCountdownProps) {
  const remaining = until - now;
  const expired = remaining <= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] ${
        expired
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : "border-white/15 bg-white/5 text-white/70"
      } ${className ?? ""}`}
      data-testid="retention-countdown"
      title={`Retention until ${new Date(until).toISOString()}`}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {formatRemaining(remaining)}
    </span>
  );
}
