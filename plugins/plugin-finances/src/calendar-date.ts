/**
 * Calendar-day keys in a named IANA zone. Due dates are stored as bare
 * `YYYY-MM-DD` strings the owner reads on their own calendar, so "is this bill
 * overdue" must compare against today's date in the owner's zone rather than
 * the UTC date, which is already tomorrow every evening west of Greenwich.
 */

const DAY_KEY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = DAY_KEY_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DAY_KEY_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Return the `YYYY-MM-DD` calendar day that `instant` falls on in `timeZone`.
 * Throws the Intl `RangeError` for an unknown zone; callers validate first.
 */
export function calendarDateKeyInZone(instant: Date, timeZone: string): string {
  const parts = dayKeyFormatter(timeZone).formatToParts(instant);
  const read = (type: "year" | "month" | "day"): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Calendar ${type} unavailable for zone ${timeZone}`);
    }
    return part.value;
  };
  return `${read("year").padStart(4, "0")}-${read("month")}-${read("day")}`;
}
