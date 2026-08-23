/**
 * Pure subtitle / metadata parsers for VideoService (no runtime imports).
 */

/** yt-dlp compact `YYYYMMDD` or general date string → UTC midnight Date, or undefined. */
export function parseYtDlpUploadDate(
  value: string | undefined,
): Date | undefined {
  if (!value) return undefined;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const year = Number(compact[1]);
    const month = Number(compact[2]);
    const day = Number(compact[3]);
    // Date.UTC overflows invalid calendar days (e.g. 20240231 → March 2).
    // Round-trip Y/M/D so impossible compact dates reject as undefined.
    const d = new Date(0);
    d.setUTCFullYear(year, month - 1, day);
    const parsed = d;
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return undefined;
    }
    return parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Collapse CRLF / bare CR / LF into single spaces (no residual `\r`). */
export function normalizeCaptionNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
}
