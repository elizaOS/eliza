import { Clock } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

interface RetentionCountdownProps {
  /** Epoch-ms at which the data expires / is purged. */
  until: number;
  now?: number;
  className?: string;
}

function formatRemaining(ms: number, t: ReturnType<typeof useT>): string {
  if (ms <= 0) return t("cloud.retention.expired", { defaultValue: "expired" });
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2)
    return t("cloud.retention.expiresInDays", {
      days,
      defaultValue: "expires in {{days}}d",
    });
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2)
    return t("cloud.retention.expiresInHours", {
      hours,
      defaultValue: "expires in {{hours}}h",
    });
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1)
    return t("cloud.retention.expiresInMinutes", {
      minutes,
      defaultValue: "expires in {{minutes}}m",
    });
  return t("cloud.retention.expiresSoon", {
    defaultValue: "expires in <1m",
  });
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
  const t = useT();
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
      title={t("cloud.retention.retentionUntil", {
        date: new Date(until).toISOString(),
        defaultValue: "Retention until {{date}}",
      })}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {formatRemaining(remaining, t)}
    </span>
  );
}
