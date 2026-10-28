/** Pure Calendar request-date/clock parsing, shared without loading services or action construction. */
import {
  addDaysToLocalDate,
  getZonedDateParts,
  isRealCalendarDay,
} from "./time.js";

const I18N_LOCALES = ["en", "zh-CN", "ko", "es", "pt", "vi", "tl"];

function buildIntlMonthMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let month = 0; month < 12; month++) {
      const date = new Date(2024, month, 15);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { month: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = month + 1;
      }
    }
  }
  return map;
}

function buildIntlWeekdayMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(2024, 0, 7 + dow);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { weekday: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = dow;
      }
    }
  }
  return map;
}

const MONTH_MAP: Record<string, number> = buildIntlMonthMap();

const WEEKDAY_MAP: Record<string, number> = buildIntlWeekdayMap();

const SPACED_WORD_CHAR = String.raw`(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{M}\p{N}_]`;

const SPACED_WORD_CHAR_PATTERN = new RegExp(`^${SPACED_WORD_CHAR}$`, "u");

function wholeWordSource(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = SPACED_WORD_CHAR_PATTERN.test(name.at(0) ?? "")
    ? `(?<!${SPACED_WORD_CHAR})`
    : "";
  const close = SPACED_WORD_CHAR_PATTERN.test(name.at(-1) ?? "")
    ? `(?!${SPACED_WORD_CHAR})`
    : "";
  return `${open}${escaped}${close}`;
}

const MONTH_NAMES_SORTED = Object.keys(MONTH_MAP).sort(
  (a, b) => b.length - a.length,
);

export const MONTH_NAME_PATTERN = new RegExp(
  `(${MONTH_NAMES_SORTED.map(wholeWordSource).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "iu",
);

const WEEKDAY_NAMES_SORTED = Object.keys(WEEKDAY_MAP)
  .filter((name) => name.length > 1)
  .sort((a, b) => b.length - a.length);

const HAN_WEEKDAY_PREFIX = /^(?:周|週|星期|礼拜|禮拜)/u;

const HAN_COUNT_BEFORE =
  "(?<![〇零一二两兩三四五六七八九十百几幾数數0-9０-９])";

const HAN_SUNDAY_COMPOUND_AFTER = "(?![程期子常记記历曆])";

const HAN_NUMBERED_DAY_COUNT_AFTER = "(?![天次个個年月周週遍回])";

function weekdayNameSource(name: string): string {
  const source = wholeWordSource(name);
  if (!HAN_WEEKDAY_PREFIX.test(name)) return source;
  return `${HAN_COUNT_BEFORE}${source}${
    name.endsWith("日")
      ? HAN_SUNDAY_COMPOUND_AFTER
      : HAN_NUMBERED_DAY_COUNT_AFTER
  }`;
}

export const WEEKDAY_NAME_PATTERN = new RegExp(
  `(?:(?<!${SPACED_WORD_CHAR})(this|next)\\s+)?(${WEEKDAY_NAMES_SORTED.map(weekdayNameSource).join("|")})`,
  "iu",
);

const CJK_NEXT_WEEK_QUALIFIER =
  /(?:(?<![\p{L}\p{N}])(?:다음\s*주|담주)(?:\s*의)?|(?<!下)下个?(?:周|星期|礼拜|禮拜)?的?)\s*$/u;

const CJK_WEEK_AFTER_NEXT_QUALIFIER =
  /(?:(?<![\p{L}\p{N}])(?:다다음\s*주|다담주)(?:\s*의)?|(?<!下)下下个?(?:周|星期|礼拜|禮拜)?的?)\s*$/u;

const CJK_UNRESOLVED_WEEK_QUALIFIER =
  /(?:(?<![\p{L}\p{N}])(?:지난\s*주|지난|저번\s*주|저번|매주|매)(?:\s*의)?|(?:上个?|每个?)(?:周|星期|礼拜|禮拜)?的?)\s*$/u;

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const RELATIVE_NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function relativeCountToNumber(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return RELATIVE_NUMBER_WORDS[token] ?? null;
}

function parseRelativeDayOffset(text: string): number | null {
  if (/\bday after tomorrow\b/.test(text)) return 2;
  if (/\bday before yesterday\b/.test(text)) return -2;

  const inMatch = text.match(
    /\bin (\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?)\b/,
  );
  if (inMatch?.[1] && inMatch[2]) {
    const count = relativeCountToNumber(inMatch[1]);
    if (count !== null) {
      return inMatch[2].startsWith("week") ? count * 7 : count;
    }
  }

  const fromNowMatch = text.match(
    /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?) from (?:now|today)\b/,
  );
  if (fromNowMatch?.[1] && fromNowMatch[2]) {
    const count = relativeCountToNumber(fromNowMatch[1]);
    if (count !== null) {
      return fromNowMatch[2].startsWith("week") ? count * 7 : count;
    }
  }

  if (/\btomorrow\b/.test(text)) return 1;
  if (/\byesterday\b/.test(text)) return -1;
  if (/\btoday\b/.test(text)) return 0;
  return null;
}

export function parseExplicitLocalDate(
  value: string,
  timeZone: string,
  now: Date = new Date(),
): { year: number; month: number; day: number } | null {
  const normalized = normalizeText(value);
  const localToday = getZonedDateParts(now, timeZone);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    // Do not reinterpret an invalid ISO date as a yearless numeric date.
    return isRealCalendarDay(year, month, day) ? { year, month, day } : null;
  }

  const monthNameMatch = normalized.match(MONTH_NAME_PATTERN);
  if (monthNameMatch) {
    const monthName = monthNameMatch[1];
    if (!monthName) {
      return null;
    }
    const month = MONTH_MAP[normalizeLookupKey(monthName)];
    if (month === undefined) {
      return null;
    }
    const year = monthNameMatch[3]
      ? Number(monthNameMatch[3])
      : localToday.year;
    const day = Number(monthNameMatch[2]);
    return isRealCalendarDay(year, month, day) ? { year, month, day } : null;
  }

  const numericMatch = normalized.match(
    /\b(\d{1,2})([/-])(\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const yearRaw = numericMatch[4];
    const parsedYear =
      yearRaw === undefined
        ? localToday.year
        : yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw);
    const month = Number(numericMatch[1]);
    const day = Number(numericMatch[3]);
    // A year-less dash pair alongside a named weekday ("friday 3-5") is a
    // wall-clock time range, not a date — let the weekday branch below win
    // (#21941).
    const yearlessDashTimeRange =
      yearRaw === undefined &&
      numericMatch[2] === "-" &&
      WEEKDAY_NAME_PATTERN.test(normalized);
    // Range-check and round-trip through Date.UTC so impossible dates
    // (month 25, Feb 30) fall through to the later branches instead of
    // rolling over (#21941).
    const isRealDate = isRealCalendarDay(parsedYear, month, day);
    if (isRealDate && !yearlessDashTimeRange) {
      return {
        year: parsedYear,
        month,
        day,
      };
    }
  }

  const weekdayMatch = normalized.match(WEEKDAY_NAME_PATTERN);
  const beforeWeekday = weekdayMatch
    ? normalized.slice(0, weekdayMatch.index)
    : "";
  if (weekdayMatch && !CJK_UNRESOLVED_WEEK_QUALIFIER.test(beforeWeekday)) {
    const cjkWeeksAhead = CJK_WEEK_AFTER_NEXT_QUALIFIER.test(beforeWeekday)
      ? 2
      : CJK_NEXT_WEEK_QUALIFIER.test(beforeWeekday)
        ? 1
        : 0;
    const qualifier =
      cjkWeeksAhead > 0
        ? "cjk-week"
        : normalizeLookupKey(weekdayMatch[1] ?? "");
    const weekdayKey = normalizeLookupKey(weekdayMatch[2] ?? "");
    const targetWeekday = WEEKDAY_MAP[weekdayKey];
    if (targetWeekday !== undefined) {
      const dCur = new Date(0);
      dCur.setUTCFullYear(
        localToday.year,
        Math.max(0, localToday.month - 1),
        localToday.day,
      );
      dCur.setUTCHours(12, 0, 0, 0);
      const currentWeekday = dCur.getUTCDay();
      let delta = (targetWeekday - currentWeekday + 7) % 7;
      if (qualifier === "next") {
        delta = delta === 0 ? 7 : delta + 7;
      } else if (qualifier === "cjk-week") {
        // 下周 / 다음 주 (下下周 / 다다음 주) name the weekday inside the
        // Monday-start week one (two) weeks ahead, so count to that Monday,
        // then into the week.
        const mondayIndex = (weekday: number) => (weekday + 6) % 7;
        delta =
          7 * cjkWeeksAhead -
          mondayIndex(currentWeekday) +
          mondayIndex(targetWeekday);
      }
      return addDaysToLocalDate(
        {
          year: localToday.year,
          month: localToday.month,
          day: localToday.day,
        },
        delta,
      );
    }
  }

  // Relative-date phrasing fallback ("tomorrow", "in 2 days", "a week from
  // today", …) — checked after the specific date patterns so e.g. an ISO date
  // still wins (#8795).
  const relativeOffset = parseRelativeDayOffset(normalized);
  if (relativeOffset !== null) {
    return addDaysToLocalDate(
      {
        year: localToday.year,
        month: localToday.month,
        day: localToday.day,
      },
      relativeOffset,
    );
  }

  return null;
}

export type StatedClockTime = { hour: number; minute: number };

export type StatedClockTimes =
  | { kind: "none" }
  | { kind: "one"; start: StatedClockTime; end?: StatedClockTime }
  | { kind: "several" };

const STATED_MERIDIEM_SOURCE = String.raw`(a\.?m\.?|p\.?m\.?)`;

export const STATED_CLOCK_MENTION_SOURCE = String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}(?![a-z])|\b(noon|midnight)\b|\b([01]\d|2[0-3]):([0-5]\d)\b(?!\s*${STATED_MERIDIEM_SOURCE})`;

const STATED_CLOCK_MENTION_PATTERN = new RegExp(
  STATED_CLOCK_MENTION_SOURCE,
  "gi",
);

const STATED_CLOCK_RANGE_PATTERN = new RegExp(
  String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}?\s*(?:-|–|—|until|till|through|to)\s*(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}(?![a-z])`,
  "i",
);

function clockFromStatedParts(
  hourRaw: string | undefined,
  minuteRaw: string | undefined,
  meridiem: string | undefined,
): StatedClockTime | null {
  if (hourRaw === undefined) return null;
  const hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === undefined) {
    return hour >= 0 && hour <= 23 ? { hour, minute } : null;
  }
  if (hour < 1 || hour > 12) return null;
  const afternoon = meridiem.toLowerCase().startsWith("p");
  return { hour: (hour % 12) + (afternoon ? 12 : 0), minute };
}

export function parseStatedClockTimes(text: string): StatedClockTimes {
  const normalized = normalizeText(text);
  const range = STATED_CLOCK_RANGE_PATTERN.exec(normalized);
  let remainder = normalized;
  let start: StatedClockTime | undefined;
  let end: StatedClockTime | undefined;
  if (range) {
    const rangeStart = clockFromStatedParts(
      range[1],
      range[2],
      range[3] ?? range[6],
    );
    const rangeEnd = clockFromStatedParts(range[4], range[5], range[6]);
    if (!rangeStart || !rangeEnd) return { kind: "several" };
    start = rangeStart;
    end = rangeEnd;
    remainder = `${normalized.slice(0, range.index)} ${normalized.slice(
      range.index + range[0].length,
    )}`;
  }
  const mentions: StatedClockTime[] = [];
  for (const match of remainder.matchAll(STATED_CLOCK_MENTION_PATTERN)) {
    const mention =
      match[4] !== undefined
        ? { hour: match[4].toLowerCase() === "noon" ? 12 : 0, minute: 0 }
        : match[5] !== undefined
          ? clockFromStatedParts(match[5], match[6], undefined)
          : clockFromStatedParts(match[1], match[2], match[3]);
    if (!mention) return { kind: "several" };
    mentions.push(mention);
  }
  if (start) {
    return mentions.length > 0
      ? { kind: "several" }
      : { kind: "one", start, ...(end ? { end } : {}) };
  }
  const distinct = new Set(
    mentions.map((mention) => `${mention.hour}:${mention.minute}`),
  );
  const only = mentions[0];
  if (distinct.size === 0 || only === undefined) return { kind: "none" };
  if (distinct.size > 1) return { kind: "several" };
  return { kind: "one", start: only };
}
