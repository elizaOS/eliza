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
  if (seconds == null || seconds < 0) return "—";
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

/**
 * Format a byte count in human-readable units.
 */
export function formatByteSize(
  bytes: number,
  options: ByteSizeFormatterOptions = {},
): string {
  const {
    unknownLabel = "unknown",
    kbPrecision = 1,
    mbPrecision = 1,
    gbPrecision = 1,
    tbPrecision = 1,
  } = options;

  if (!Number.isFinite(bytes) || bytes < 0) return unknownLabel;
  if (bytes >= 1024 ** 4) {
    return `${(bytes / 1024 ** 4).toFixed(tbPrecision)} TB`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(gbPrecision)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(mbPrecision)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(kbPrecision)} KB`;
  }
  return `${bytes} B`;
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
  if (ms < 60_000) {
    const value = Math.round(ms / 1000);
    return t ? t("format.duration.seconds", { value }) : `${value}s`;
  }
  if (ms < 3_600_000) {
    const value = Math.round(ms / 60_000);
    return t ? t("format.duration.minutes", { value }) : `${value}m`;
  }
  if (ms < 86_400_000) {
    const hours = ms / 3_600_000;
    const value =
      hours === Math.floor(hours) ? hours : Number(hours.toFixed(1));
    return t ? t("format.duration.hours", { value }) : `${value}h`;
  }
  const days = ms / 86_400_000;
  const value = days === Math.floor(days) ? days : Number(days.toFixed(1));
  return t ? t("format.duration.days", { value }) : `${value}d`;
}
