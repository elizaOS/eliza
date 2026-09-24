/**
 * Shared formatting helpers for Eliza app views.
 */

/**
 * Format an uptime duration in seconds into a compact human string.
 *
 * When `verbose` is true the output uses every non-zero unit (e.g. "2d 3h 15m").
 * Otherwise the two most-significant units are returned (e.g. "2d 3h").
 */
export function formatUptime(seconds?: number, verbose?: boolean): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (verbose) {
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (parts.length === 0) parts.push(`${s}s`);
    return parts.join(" ");
  }

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

type DateFormatOptions = {
  /**
   * Fallback string for empty/invalid dates.
   */
  fallback?: string;
  /**
   * Optional locale override.
   */
  locale?: string;
};

type DurationFormatOptions = {
  /**
   * Fallback string for non-positive/invalid durations.
   */
  fallback?: string;
  /**
   * Optional translation function for localized duration labels.
   * When provided, uses i18n keys like "format.duration.seconds" etc.
   */
  t?: (key: string, vars?: Record<string, string | number>) => string;
};

const ISO_CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;

function hasValidIsoCalendarDate(value: string): boolean {
  const match = ISO_CALENDAR_DATE_PREFIX.exec(value);
  if (!match) return true;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function parseDisplayDate(
  value: number | string | Date | null | undefined,
): Date | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && !hasValidIsoCalendarDate(value)) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Format a byte count in human-readable units.
 */
export { formatByteSize } from "@elizaos/core/utils/format-bytes";

type UsdFormatOptions = {
  /**
   * Fallback string for null / undefined / non-numeric input.
   */
  fallback?: string;
};

const DECIMAL_NUMBER_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Format a numeric amount as a USD currency string (`$1,234.56`).
 *
 * Accepts numbers or complete decimal strings (optionally using exponent
 * notation); non-numeric input yields `fallback`.
 * Uses the en-US `Intl.NumberFormat` currency style (grouped, 2 fraction
 * digits) — the canonical money display for dashboard views.
 */
export function formatUsd(
  value: number | string | null | undefined,
  options: UsdFormatOptions = {},
): string {
  const { fallback = "—" } = options;
  let amount: number | null | undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    amount = DECIMAL_NUMBER_PATTERN.test(trimmed)
      ? Number(trimmed)
      : Number.NaN;
  } else {
    amount = value;
  }
  if (amount == null || !Number.isFinite(amount)) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

/**
 * Format timestamp / date for locale display (`toLocaleString`).
 */
export function formatDateTime(
  value: number | string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const { fallback = "—", locale } = options;
  const parsed = parseDisplayDate(value);
  if (!parsed) return fallback;
  return parsed.toLocaleString(locale);
}

/**
 * Format timestamp / date as locale time only (`toLocaleTimeString`).
 */
export function formatTime(
  value: number | string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const { fallback = "—", locale } = options;
  const parsed = parseDisplayDate(value);
  if (!parsed) return fallback;
  return parsed.toLocaleTimeString(locale);
}

/**
 * Format timestamp / date as locale date only (`toLocaleDateString`).
 */
export function formatShortDate(
  value: number | string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const { fallback = "—", locale } = options;
  const parsed = parseDisplayDate(value);
  if (!parsed) return fallback;
  return parsed.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Format an elapsed duration in milliseconds into a compact human string.
 */
export function formatDurationMs(
  ms?: number | null,
  options: DurationFormatOptions = {},
): string {
  const { fallback = "—", t } = options;
  if (ms == null || !Number.isFinite(ms) || ms < 0) return fallback;
  // Round within each unit FIRST, and only keep the unit when the rounded
  // value stays below the next unit's threshold — otherwise values just
  // under a boundary render as nonsense like "60s" / "60m" / "24h"
  // (e.g. 59_500 ms must be "1m", not "60s").
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return t ? t("format.duration.seconds", { value: seconds }) : `${seconds}s`;
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return t ? t("format.duration.minutes", { value: minutes }) : `${minutes}m`;
  }
  const hours = ms / 3_600_000;
  const hoursValue =
    hours === Math.floor(hours) ? hours : Number(hours.toFixed(1));
  if (hoursValue < 24) {
    return t
      ? t("format.duration.hours", { value: hoursValue })
      : `${hoursValue}h`;
  }
  const days = ms / 86_400_000;
  const value = days === Math.floor(days) ? days : Number(days.toFixed(1));
  return t ? t("format.duration.days", { value }) : `${value}d`;
}

type RelativeTimeTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
) => string;
const WEEK_MS = 7 * 86400000;
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
    mins: round(absMs / 60000),
    hours: round(absMs / 3600000),
    days: round(absMs / 86400000),
  };
}
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
  if (absMs < 60000) return "now";
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
  if (absMs < 60000) return t ? t("conversations.justNow") : "just now";
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
