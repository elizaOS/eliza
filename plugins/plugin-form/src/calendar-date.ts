/**
 * Host-timezone-independent calendar-date parsing and display for the `date`
 * control type. A form answer names a calendar day, not an instant, so the
 * stored value is always `YYYY-MM-DD` and neither parsing nor display may pass
 * through a UTC/local conversion that can move the day: `Date.parse` reads
 * "September 15, 2026" as local midnight and `toISOString` re-renders it in
 * UTC (the 14th east of UTC), while `new Date("2026-09-15")` is UTC midnight and
 * `toLocaleDateString` renders it as the 14th west of UTC.
 */

const ISO_CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FOUR_DIGIT_YEAR_RE = /\b\d{4}\b/;

/** Calendar components of a `YYYY-MM-DD` string, or null when it is not a real day. */
export function calendarDateComponents(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = ISO_CALENDAR_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip through UTC to reject roll-overs such as 2026-02-30 → Mar 2.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Resolve an extracted answer to the calendar day it names, as `YYYY-MM-DD`.
 * ISO input is validated and returned as-is. Any other format must carry a
 * four-digit year (V8 silently defaults a year-less date to 2001) and is read
 * back through the local calendar components of the parsed instant, which is
 * the day the user named on every host timezone. Returns null when the input
 * does not name a real day, so the caller leaves the raw answer for validation
 * to reject and the form re-asks.
 */
export function parseCalendarDate(value: string): string | null {
  const trimmed = value.trim();
  if (ISO_CALENDAR_DATE_RE.test(trimmed)) {
    return calendarDateComponents(trimmed) ? trimmed : null;
  }
  if (!FOUR_DIGIT_YEAR_RE.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const candidate = `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  return calendarDateComponents(candidate) ? candidate : null;
}

/**
 * Locale display of a stored `YYYY-MM-DD` value that names the same day on
 * every host. Anything that is not a calendar date is echoed unchanged.
 */
export function formatCalendarDate(value: string): string {
  const parts = calendarDateComponents(value.trim());
  if (!parts) return value;
  return new Date(parts.year, parts.month - 1, parts.day).toLocaleDateString();
}
