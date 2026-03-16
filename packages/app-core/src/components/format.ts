/**
 * Shared formatting helpers for Milady app views.
 */

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
  const { fallback = "—" } = options;
  if (!ms || ms <= 0) return fallback;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const hours = ms / 3_600_000;
    return hours === Math.floor(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  const days = ms / 86_400_000;
  return days === Math.floor(days) ? `${days}d` : `${days.toFixed(1)}d`;
}
