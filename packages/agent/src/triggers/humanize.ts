/**
 * Human phrasing for trigger schedules in chat replies. Machine forms — ISO
 * timestamps, cron expressions, raw millisecond intervals — must never reach
 * the user's message; the TRIGGER action renders schedules through these
 * helpers and keeps the machine detail in its structured `data` payload.
 * Clock times render in the process-local timezone: the local-first
 * deployment runs the agent on the user's own machine, so local time is the
 * user's time. Cron fields are echoed as written (the scheduler interprets
 * them in the trigger's own timezone), so no conversion applies there.
 */

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Below this lead time a one-shot reads as a countdown ("in 20 minutes"). */
const RELATIVE_CUTOFF_MS = 45 * MINUTE_MS;

function formatClockTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "am" : "pm";
  if (minute === 0) return `${h12}${suffix}`;
  return `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
}

// "every morning at 8am" reads the way people ask for it; hours without a
// natural noun (late night / small hours) fall back to "every day at …".
function timeOfDayNoun(hour: number): string | null {
  if (hour >= 5 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 21) return "evening";
  return null;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  if (rem10 === 1) return `${n}st`;
  if (rem10 === 2) return `${n}nd`;
  if (rem10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * Describe a 5-field cron expression as human recurrence ("every morning at
 * 8am", "every Monday at 9am"). Returns null for shapes outside the common
 * reminder vocabulary — callers fall back to a neutral phrase, never the raw
 * expression.
 */
export function describeCronSchedule(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;
  if (monthPart !== "*") return null;

  const everyN = minPart.match(/^\*\/(\d+)$/);
  if (everyN && hourPart === "*" && domPart === "*" && dowPart === "*") {
    const n = Number.parseInt(everyN[1], 10);
    if (n <= 0) return null;
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  if (
    minPart === "0" &&
    hourPart === "*" &&
    domPart === "*" &&
    dowPart === "*"
  ) {
    return "every hour";
  }

  // Single-integer minute and hour only: parsing the first number out of a
  // range/list would confidently describe a multi-fire schedule as one time.
  if (!/^\d+$/.test(minPart) || !/^\d+$/.test(hourPart)) return null;
  const minute = Number.parseInt(minPart, 10);
  const hour = Number.parseInt(hourPart, 10);
  if (minute > 59 || hour > 23) return null;
  const time = formatClockTime(hour, minute);

  if (domPart === "*" && dowPart === "*") {
    const noun = timeOfDayNoun(hour);
    return noun ? `every ${noun} at ${time}` : `every day at ${time}`;
  }
  if (domPart === "*" && dowPart === "1-5") return `every weekday at ${time}`;
  if (domPart === "*" && (dowPart === "0,6" || dowPart === "6,0")) {
    return `every weekend at ${time}`;
  }
  if (domPart === "*" && /^[0-7]$/.test(dowPart)) {
    // POSIX alias: 7 is Sunday.
    const dow = Number.parseInt(dowPart, 10) % 7;
    return `every ${DAY_NAMES[dow]} at ${time}`;
  }
  if (dowPart === "*" && /^\d+$/.test(domPart)) {
    const dom = Number.parseInt(domPart, 10);
    if (dom < 1 || dom > 31) return null;
    return `on the ${ordinal(dom)} of every month at ${time}`;
  }
  return null;
}

/**
 * Describe a one-shot fire time relative to now: a countdown for near-term
 * fires ("in 5 minutes"), then local clock forms ("today at 3pm", "tomorrow
 * at 8am", "on Saturday at 8am", "on Aug 20 at 8am"). Returns null only for
 * an unparseable timestamp.
 */
export function describeOnceAt(
  scheduledAtIso: string,
  nowMs: number,
): string | null {
  const atMs = Date.parse(scheduledAtIso);
  if (Number.isNaN(atMs)) return null;
  const delta = atMs - nowMs;
  if (delta > 0 && delta < MINUTE_MS) return "in under a minute";
  if (delta > 0 && delta < RELATIVE_CUTOFF_MS) {
    const minutes = Math.round(delta / MINUTE_MS);
    return minutes <= 1 ? "in a minute" : `in ${minutes} minutes`;
  }

  const at = new Date(atMs);
  const now = new Date(nowMs);
  const time = formatClockTime(at.getHours(), at.getMinutes());
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `on ${DAY_NAMES[at.getDay()]} at ${time}`;
  }
  const year =
    at.getFullYear() === now.getFullYear() ? "" : `, ${at.getFullYear()}`;
  return `on ${MONTH_NAMES[at.getMonth()]} ${at.getDate()}${year} at ${time}`;
}

/**
 * Describe a repeat interval ("every 12 hours", "every 90 minutes"). Picks
 * the largest unit that divides evenly; sub-second remainders round to
 * seconds so raw millisecond counts never surface.
 */
export function describeIntervalMs(intervalMs: number): string {
  const every = (n: number, unit: string) =>
    n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  if (intervalMs >= DAY_MS && intervalMs % DAY_MS === 0) {
    return every(intervalMs / DAY_MS, "day");
  }
  if (intervalMs >= HOUR_MS && intervalMs % HOUR_MS === 0) {
    return every(intervalMs / HOUR_MS, "hour");
  }
  if (intervalMs >= MINUTE_MS && intervalMs % MINUTE_MS === 0) {
    return every(intervalMs / MINUTE_MS, "minute");
  }
  return every(Math.max(1, Math.round(intervalMs / 1000)), "second");
}
