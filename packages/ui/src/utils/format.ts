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

/** One week in milliseconds — the boundary past which both relative formatters
 * fall back to an absolute locale date. The gate uses the RAW magnitude, not
 * the ceiled day count: a future value of 6d + 1ms ceils to 7 days but is
 * still inside the week, and must render "in 7d" rather than jump early to a
 * date the past direction would not show until a full week. */
const WEEK_MS = 7 * 86_400_000;

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
 *
 * Past compact output is language-neutral (`5m`), so it takes no translation.
 * Future output carries the direction word, so callers on localized surfaces
 * pass `t` and the label resolves through the same `conversations.in*` keys as
 * the long formatter (English catalog fallback applies until translated);
 * callers without i18n omit it and receive the English defaults.
 */
export function formatRelativeTimeShort(
  value: string | number | Date,
  t?: RelativeTimeTranslator,
): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "now";
  const { future, absMs, mins, hours, days } = relativeTimeParts(
    Date.now() - time,
  );
  if (absMs < 60_000) return "now";
  if (absMs >= WEEK_MS) return date.toLocaleDateString();
  if (mins < 60) {
    if (future) {
      return t ? t("conversations.inMinutes", { count: mins }) : `in ${mins}m`;
    }
    return `${mins}m`;
  }
  if (hours < 24) {
    if (future) {
      return t ? t("conversations.inHours", { count: hours }) : `in ${hours}h`;
    }
    return `${hours}h`;
  }
  if (future) {
    return t ? t("conversations.inDays", { count: days }) : `in ${days}d`;
  }
  return `${days}d`;
}

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
  const { future, absMs, mins, hours, days } = relativeTimeParts(
    Date.now() - time,
  );

  if (absMs < 60_000) return t ? t("conversations.justNow") : "just now";
  if (absMs >= WEEK_MS) return date.toLocaleDateString();
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
  if (future) {
    return t ? t("conversations.inDays", { count: days }) : `in ${days}d`;
  }
  return t ? t("conversations.daysAgo", { count: days }) : `${days}d ago`;
}
