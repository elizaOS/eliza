/**
 * Re-exports the shared display formatters (byte size, date/time, duration).
 */
export {
  formatByteSize,
  formatDateTime,
  formatDurationMs,
  formatShortDate,
  formatTime,
  formatUptime,
} from "@elizaos/shared";

type RelativeTimeTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
) => string;

/**
 * Canonical "time ago" formatter for UI surfaces.
 *
 * The bucketing (just-now / minutes / hours / days, then an absolute date
 * past one week) is shared. Callers in i18n contexts pass a `t` translator
 * keyed under `conversations.*`; callers without i18n omit it and receive the
 * English defaults. Past one week the value falls back to a locale date.
 */
export function formatRelativeTime(
  value: string | number | Date,
  t?: RelativeTimeTranslator,
): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    return t ? t("conversations.justNow") : "just now";
  }
  const diffMs = Date.now() - time;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return t ? t("conversations.justNow") : "just now";
  if (diffMins < 60) {
    return t
      ? t("conversations.minutesAgo", { count: diffMins })
      : `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return t
      ? t("conversations.hoursAgo", { count: diffHours })
      : `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return t
      ? t("conversations.daysAgo", { count: diffDays })
      : `${diffDays}d ago`;
  }
  return date.toLocaleDateString();
}
