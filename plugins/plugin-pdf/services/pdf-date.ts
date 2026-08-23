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

  if (relation === undefined) {
    const localDate = new Date(0);
    localDate.setFullYear(year, monthIndex, day);
    localDate.setHours(hour, minute, second, 0);
    return Number.isFinite(localDate.getTime()) ? localDate : undefined;
  }

  const offsetHour = clampInt(matches[8], 0, 23, 0);
  const offsetMinute = clampInt(matches[9], 0, 59, 0);

  let hourUtc = hour;
  let minuteUtc = minute;
  if (relation === "-") {
    hourUtc += offsetHour;
    minuteUtc += offsetMinute;
  } else if (relation === "+") {
    hourUtc -= offsetHour;
    minuteUtc -= offsetMinute;
  }

  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(hourUtc, minuteUtc, second, 0);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
