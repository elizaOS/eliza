/**
 * Deterministic date-window resolution from the member's own words.
 *
 * The 2026-10-07 live eval showed gpt-6-luna often leaves `until` empty even when the
 * member states it ("I'm traveling to New York until November 3"). Code resolves the
 * common English patterns itself; the model's dates are used only when this finds none.
 * Dates are calendar days at 00:00 UTC (the member store has no time-of-day semantics).
 * "Today" is the member's local calendar day: callers pass `zonedNow(now, timeZone)`
 * (audit plugin-prototypes-3: at 7pm in California it is already tomorrow in UTC, so
 * "the 7th" resolved to next month).
 */

/**
 * `now` shifted so that its UTC fields read as the wall-clock time in `timeZone`.
 * No zone (or an unknown one) keeps UTC.
 */
export function zonedNow(now: Date, timeZone?: string | null): Date {
  if (!timeZone) return now;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    return new Date(
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      ),
    );
  } catch {
    return now;
  }
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  few: 3,
  "a few": 3,
  couple: 2,
  "a couple": 2,
  "a couple of": 2,
};

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAY = String.raw`(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const DATE_EXPR = new RegExp(
  String.raw`\b(?:${MONTH}\s+${DAY}|${DAY}\s+(?:of\s+)?${MONTH}|the\s+${DAY}(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)|(next\s+)?${WEEKDAY}|tomorrow|(?!may\b)${MONTH}|after\s+new\s*year'?s?|(\d{1,2})\/(\d{1,2}))\b`,
  "i",
);

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const startOfDay = (now: Date) =>
  day(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const monthIndex = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase());

/** Next calendar day (today excluded) with this day-of-month. */
function nextDayOfMonth(n: number, today: Date): Date | null {
  if (n < 1 || n > 31) return null;
  for (let k = 0; k < 13; k++) {
    const m = today.getUTCMonth() + k;
    const d = day(today.getUTCFullYear(), m, n);
    if (d.getUTCDate() === n && d > today) return d;
  }
  return null;
}

/** Next occurrence (today excluded) of month/day, or of the month's first day. */
function nextMonthDay(m: number, n: number, today: Date): Date | null {
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const candidate = day(year, m, n);
    // Date.UTC rolls a day that does not exist in the month (Feb 30, Apr 31,
    // day 0) into a neighbouring month. That rolled date is not the stated
    // date, so skip it — the same existence check nextDayOfMonth applies.
    if (candidate.getUTCMonth() !== m || candidate.getUTCDate() !== n) continue;
    if (candidate > today) return candidate;
  }
  return null;
}

function nextWeekday(w: number, today: Date, nextWeek: boolean): Date {
  let delta = (w - today.getUTCDay() + 7) % 7 || 7;
  if (nextWeek) {
    // "next monday" = the one in next calendar week (weeks start Monday).
    const toNextMonday = (8 - today.getUTCDay()) % 7 || 7;
    const nextMonday = addDays(today, toNextMonday);
    delta = toNextMonday + ((w + 6) % 7);
    return addDays(today, delta) >= nextMonday
      ? addDays(today, delta)
      : nextMonday;
  }
  return addDays(today, delta);
}

/** Parses one date expression (already isolated) relative to today. */
export function parseDateExpr(expr: string, now: Date): Date | null {
  const today = startOfDay(now);
  // "may" alone is a month only where a date must start ("until may"); "I may be away" is not May
  // (audit plugin-prototypes-7).
  if (/^\s*may\b(?!\s*\d)/i.test(expr)) return nextMonthDay(4, 1, today);
  const m = DATE_EXPR.exec(expr);
  if (!m) return null;
  const s = m[0].toLowerCase();
  if (/after\s+new\s*year/.test(s))
    return day(today.getUTCFullYear() + 1, 0, 2);
  if (s === "tomorrow") return addDays(today, 1);
  if (m[1] && m[2]) return nextMonthDay(monthIndex(m[1]), Number(m[2]), today);
  if (m[3] && m[4]) return nextMonthDay(monthIndex(m[4]), Number(m[3]), today);
  if (m[5]) return nextDayOfMonth(Number(m[5]), today);
  if (m[6]) return nextDayOfMonth(Number(m[6]), today);
  if (m[8]) {
    const w = WEEKDAYS.indexOf(m[8].slice(0, 3).toLowerCase());
    return nextWeekday(w, today, Boolean(m[7]));
  }
  if (m[9]) return nextMonthDay(monthIndex(m[9]), 1, today);
  if (m[10] && m[11]) {
    // US-style M/D, as members text it ("thru 11/2").
    const mo = Number(m[10]) - 1,
      d = Number(m[11]);
    return mo >= 0 && mo < 12 && d >= 1 && d <= 31
      ? nextMonthDay(mo, d, today)
      : null;
  }
  return null;
}

export interface DateWindow {
  from: string | null;
  until: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const END = String.raw`(?:until|till|til|'til|thru|through|back\s+(?:on|by|in)?|by)`;

/**
 * Resolves a {from, until} window from the member's own words, or nulls when no
 * supported pattern is present. Callers prefer this over model-proposed dates.
 */
export function resolveWindow(text: string, now: Date): DateWindow {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  const today = startOfDay(now);
  const out: DateWindow = { from: null, until: null };

  const range = new RegExp(String.raw`\bfrom\s+(.+?)\s+${END}\s+(.+)$`).exec(t);
  if (range?.[1] && range[2]) {
    const from = parseDateExpr(range[1], now);
    let until = parseDateExpr(range[2], now);
    // "from friday until monday": the end day comes next after the start day.
    if (from && until && until <= from) until = parseDateExpr(range[2], from);
    out.from = iso(from);
    out.until = iso(until);
    if (out.until) return out;
  }
  const end = new RegExp(String.raw`\b${END}\s+(?:the\s+)?(.+)$`).exec(t);
  if (end) {
    const d = parseDateExpr(
      end[0].replace(new RegExp(String.raw`^${END}\s+`), ""),
      now,
    );
    if (d) return { from: out.from, until: iso(d) };
  }
  if (/\bafter\s+new\s*year'?s?\b/.test(t))
    return { from: null, until: iso(day(today.getUTCFullYear() + 1, 0, 2)) };
  const dur =
    /\bfor\s+(a couple of|a couple|a few|couple|few|an|a|one|two|three|four|five|six|\d+)\s+(day|week|month)s?\b/.exec(
      t,
    );
  if (dur?.[1]) {
    const n = /^\d+$/.test(dur[1]) ? Number(dur[1]) : (NUMBERS[dur[1]] ?? 1);
    const until =
      dur[2] === "day"
        ? addDays(today, n)
        : dur[2] === "week"
          ? addDays(today, 7 * n)
          : (() => {
              // Clamp to the last day of the target month: Date.UTC rolls a
              // non-existent day (Jan 31 + 1 month = Feb 31) into the next
              // month (Mar 3). Same rollover class fixed in nextMonthDay
              // (#34651).
              const target = today.getUTCMonth() + n;
              const lastDay = day(
                today.getUTCFullYear(),
                target + 1,
                0,
              ).getUTCDate();
              return day(
                today.getUTCFullYear(),
                target,
                Math.min(today.getUTCDate(), lastDay),
              );
            })();
    return { from: null, until: iso(until) };
  }
  if (/\b(?:all\s+)?next\s+week\b/.test(t)) {
    const nextMonday = addDays(today, (8 - today.getUTCDay()) % 7 || 7);
    return { from: iso(nextMonday), until: iso(addDays(nextMonday, 6)) };
  }
  if (/\bthis\s+week\b/.test(t)) {
    // "this week" ends on this Sunday (structured-field.ts). Weeks start on
    // Monday, so on a Sunday this Sunday is today itself. The `|| 7`
    // next-occurrence shift used for weekdays must not apply here: it would
    // move the end to next Sunday and extend the window by a full week.
    return {
      from: null,
      until: iso(addDays(today, (7 - today.getUTCDay()) % 7)),
    };
  }
  return out;
}
