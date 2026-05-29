/**
 * Pure presentation formatters shared by the task-coordinator views.
 *
 * These are display-only helpers: they format timestamps, token counts, and
 * raw stream text for the human eye. They perform no business math — token and
 * cost values are computed server-side and arrive pre-aggregated; here we only
 * choose how to render them.
 *
 * @module view-format
 */

const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    "\\u001b(?:",
    "\\[[0-9;?]*[A-Za-z]|\\][^\\u0007]*\\u0007|[()][0-9A-Za-z])",
  ].join(""),
  "g",
);

/** Strip ANSI escape sequences from terminal output and trim whitespace. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "").trim();
}

/** Render a past epoch-ms timestamp as a localized "n minutes ago" phrase. */
export function formatRelativeTime(ts: number, locale?: string): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (deltaSeconds < 5) return formatter.format(0, "second");
  if (deltaSeconds < 60) return formatter.format(-deltaSeconds, "second");
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.floor(hours / 24), "day");
}

/** Render an ISO timestamp string as relative time, or a fallback when absent. */
export function formatIsoRelative(
  value: string | null | undefined,
  locale: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatRelativeTime(date.getTime(), locale);
}

/** Render an absolute clock time (HH:MM) for a timeline entry. */
export function formatClockTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

/** Compact token/count rendering (e.g. 12.3K, 1.2M) via the Intl formatter. */
export function formatCompactNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Render a USD cost figure; sub-dollar costs keep more precision. */
export function formatUsd(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value !== 0 && value < 1 ? 4 : 2,
  }).format(value);
}
