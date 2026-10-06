/**
 * Lightweight PDF-spec date parser — no @elizaos/core deps so regression
 * tests can import it without pulling provider-integrations → @noble/hashes.
 */

const PDF_SPEC_DATE_REGEX =
  /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?'?$/;

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function matchesUtcWallClock(
  date: Date,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): boolean {
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIndex &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/**
 * Parses the PDF-spec `D:` date string into a {@link Date}. When the string
 * carries a UT relation (`Z`, `+`, or `-`) the declared offset is applied so the
 * returned instant is absolute UTC. When the UT relation is omitted the zone is
 * unknown and, per PDF Reference 3.8.3 / ISO 32000-1 7.9.4, the remaining fields
 * are local time; that case is interpreted as host-local wall-clock via the
 * local `Date` constructor rather than fabricating a `Z` UTC claim. Returns
 * undefined for any string that is not a spec date so an unparseable value is
 * dropped rather than surfaced as an Invalid Date.
 *
 * Per-field clamps still substitute defaults for completely out-of-range
 * components (month 13 → January, day 40 → 1), matching the existing metadata
 * tests. Calendar-impossible combinations that survive those clamps (February
 * 30, April 31, February 29 outside a leap year) are dropped instead of letting
 * `Date` overflow into the next month and invent a wrong CreationDate/ModDate.
 *
 * Exported so regression tests can drive years 0-99 through the real parser
 * (`Date.UTC(10, …)` is 1910; `setUTCFullYear(10, …)` is year 10).
 */
export function parsePdfSpecDate(value: string): Date | undefined {
  const matches = PDF_SPEC_DATE_REGEX.exec(value);
  if (!matches) {
    return undefined;
  }

  const year = Number.parseInt(matches[1], 10);
  const monthIndex = clampInt(matches[2], 1, 12, 1) - 1;
  const day = clampInt(matches[3], 1, 31, 1);
  const hour = clampInt(matches[4], 0, 23, 0);
  const minute = clampInt(matches[5], 0, 59, 0);
  const second = clampInt(matches[6], 0, 59, 0);
  const relation = matches[7];

  // Validate the declared wall-clock before applying any UT offset. Offset
  // math must not be what invents a day — February 30 would otherwise become
  // March 1 (or March 1 minus the offset) and surface as a real document date.
  const wall = new Date(0);
  wall.setUTCFullYear(year, monthIndex, day);
  wall.setUTCHours(hour, minute, second, 0);
  if (!matchesUtcWallClock(wall, year, monthIndex, day, hour, minute, second)) {
    return undefined;
  }

  if (relation === undefined) {
    // Calendar validity was checked independently of the host zone. Preserve
    // Date's existing normalization through local daylight-saving gaps.
    const localDate = new Date(0);
    localDate.setFullYear(year, monthIndex, day);
    localDate.setHours(hour, minute, second, 0);
    return localDate;
  }

  if (relation === "Z") {
    return wall;
  }

  const offsetHour = clampInt(matches[8], 0, 23, 0);
  const offsetMinute = clampInt(matches[9], 0, 59, 0);
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
  // PDF `+HH'MM'` means local = UTC+offset, so UTC = local − offset.
  // PDF `-HH'MM'` means local = UTC−offset, so UTC = local + offset.
  const utcMs = relation === "+" ? wall.getTime() - offsetMs : wall.getTime() + offsetMs;
  const d = new Date(utcMs);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
