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
/**
 * Direction-aware unit buckets shared by both relative formatters.
 *
 * The previous implementations bucketed the SIGNED difference, so any future
 * timestamp (a session expiry, a scheduled item, clock skew) produced negative
 * minutes, satisfied `< 1`, and rendered as "now"/"just now" indefinitely.
 * Future magnitudes round UP so "in N <unit>" always names the minimal N such
 * that the moment arrives within N units (a target computed as now + 5 minutes
 * has already lost milliseconds by read time and must not floor to 4); past
 * magnitudes keep the original floor, so every past-direction string is
 * unchanged.
 */
function relativeTimeParts(diffMs: number): {
  future: boolean;
  absMs: number;
  mins: number;
  hours: number;
  days: number;
} {
  const future = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const round = future ? Math.ceil : Math.floor;
  return {
    future,
    absMs,
    mins: round(absMs / 60_000),
    hours: round(absMs / 3_600_000),
    days: round(absMs / 86_400_000),
  };
}

/**
 * Compact "time ago" formatter for dense surfaces (notification rows/banners):
 * bare `5m` / `3h` / `2d` with no "ago" suffix (`in 5m` when the moment is
 * ahead), `now` under a minute in either direction, and the same locale-date
 * fallback past one week as {@link formatRelativeTime}.
 */
export function formatRelativeTimeShort(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "now";
  const { future, absMs, mins, hours, days } = relativeTimeParts(
    Date.now() - time,
  );
  if (absMs < 60_000) return "now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m`;
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h`;
  if (days < 7) return future ? `in ${days}d` : `${days}d`;
  return date.toLocaleDateString();
}

export function formatRelativeTime(
  value: string | number | Date,
  t?: RelativeTimeTranslator,
): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    return t ? t("conversations.justNow") : "just now";
  }
  const { future, absMs, mins, hours, days } = relativeTimeParts(
    Date.now() - time,
  );

  if (absMs < 60_000) return t ? t("conversations.justNow") : "just now";
  if (mins < 60) {
    if (future) {
      return t ? t("conversations.inMinutes", { count: mins }) : `in ${mins}m`;
    }
    return t ? t("conversations.minutesAgo", { count: mins }) : `${mins}m ago`;
  }
  if (hours < 24) {
    if (future) {
      return t ? t("conversations.inHours", { count: hours }) : `in ${hours}h`;
    }
    return t ? t("conversations.hoursAgo", { count: hours }) : `${hours}h ago`;
  }
  if (days < 7) {
    if (future) {
      return t ? t("conversations.inDays", { count: days }) : `in ${days}d`;
    }
    return t ? t("conversations.daysAgo", { count: days }) : `${days}d ago`;
  }
  return date.toLocaleDateString();
}
