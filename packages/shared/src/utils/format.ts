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

type ByteSizeFormatterOptions = {
  /**
   * Fallback string for invalid or negative byte values.
   */
  unknownLabel?: string;
  /**
   * Uniform precision applied to all of KB / MB / GB / TB. Individual
   * per-unit overrides below take precedence when supplied.
   */
  precision?: number;
  /**
   * Precision for KB / MB / GB / TB values.
   */
  kbPrecision?: number;
  mbPrecision?: number;
  gbPrecision?: number;
  tbPrecision?: number;
};

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

/**
 * Format a byte count in human-readable units.
 */
export function formatByteSize(
  bytes: number | null | undefined,
  options: ByteSizeFormatterOptions = {},
): string {
  const {
    unknownLabel = "unknown",
    precision,
    kbPrecision = precision ?? 1,
    mbPrecision = precision ?? 1,
    gbPrecision = precision ?? 1,
    tbPrecision = precision ?? 1,
  } = options;

  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return unknownLabel;
  }
  // Largest unit first. A value just under a boundary can ROUND across it —
  // 1024**2 - 1 bytes is 1023.999… KB, which toFixed renders as the impossible
  // "1024.0 KB" — so when the rounded magnitude reaches 1024 the value is
  // promoted to the next-larger unit instead (same defect class the duration
  // formatter below guards against). TB, having no larger unit, legitimately
  // displays magnitudes of 1024 and above.
  const units = [
    { size: 1024 ** 4, suffix: "TB", precision: tbPrecision },
    { size: 1024 ** 3, suffix: "GB", precision: gbPrecision },
    { size: 1024 ** 2, suffix: "MB", precision: mbPrecision },
    { size: 1024, suffix: "KB", precision: kbPrecision },
  ];
  for (const [index, unit] of units.entries()) {
    if (bytes < unit.size) continue;
    const rounded = (bytes / unit.size).toFixed(unit.precision);
    const larger = units[index - 1];
    if (larger && Number(rounded) >= 1024) {
      return `${(bytes / larger.size).toFixed(larger.precision)} ${larger.suffix}`;
    }
    return `${rounded} ${unit.suffix}`;
  }
  return `${bytes} B`;
}

type UsdFormatOptions = {
  /**
   * Fallback string for null / undefined / non-numeric input.
   */
  fallback?: string;
};

/**
 * Format a numeric amount as a USD currency string (`$1,234.56`).
 *
 * Accepts numbers or numeric strings; non-numeric input yields `fallback`.
 * Uses the en-US `Intl.NumberFormat` currency style (grouped, 2 fraction
 * digits) — the canonical money display for dashboard views.
 */
export function formatUsd(
  value: number | string | null | undefined,
  options: UsdFormatOptions = {},
): string {
  const { fallback = "—" } = options;
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
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
  if (value == null || value === "") return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return fallback;
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
  if (value == null || value === "") return fallback;
  if (typeof value === "string" && !hasValidIsoCalendarDate(value)) {
    return fallback;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return fallback;
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
  if (value == null || value === "") return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return fallback;
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
