import { CALENDAR_NEW_SLOT_DURATION_MINUTES } from "@elizaos/contracts";
import { isValidTimeZone } from "./constants.js";
import {
  normalizeText,
  parseExplicitLocalDate,
  parseStatedClockTimes,
  STATED_CLOCK_MENTION_SOURCE,
  type StatedClockTime,
} from "./request-time.js";
import { buildUtcDateFromLocalParts, CalendarLocalTimeError } from "./time.js";

const unitWords = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const tensWords = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const slotRequest =
  /^(?:(?:cool|okay|thanks|thank you)[,.!] )?(?:(?:can|could|would) you )?(?:find(?: me)?|show me|suggest) (?:(?:a )?(?<duration>\d{1,3}|[a-z]+(?:[ -][a-z]+)?)[ -]minutes? (?:slot|gap|opening)|(?<freeHour>(?:a|one) free hour)|(?<halfHour>half an hour free|a free half[- ]hour))(?: for (?<topic>[\p{L}\p{M}]+))? (?<window>.+?)(?:(?: for| to (?:get|buy|pick up|shop for)) (?<purpose>(?:(?:a|an) )?[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)?))?(?<builtin> (?:on|in) (?:my|the) built[ -]in (?:eliza )?calendar)?$/u;
const purposeConstraint =
  /\b(?:today|tomorrow|yesterday|next|last|before|after|during|until|between|unless|if|when|while|then|and|or|with|without|except|on|in|at|past|not|only|calendar|noon|midnight)\b/u;
const day = String.raw`(?:today|tomorrow|(?:the )?day after tomorrow|\d{4}-\d{2}-\d{2})`;
const leadingDay = new RegExp(`^(${day}) (.+)$`, "u");
const trailingDay = new RegExp(`^(.+?) (${day})$`, "u");
// A first-person errand can explain the request without adding a Calendar
// filter. The same request must still name an afternoon and a simple object.
const errandPurpose = String.raw`(?:when|where) i (?:can|could) (?:actually )?(?:go )?(?:get|buy|pick up|shop for) ([\p{L}\p{M}]+(?: [\p{L}\p{M}]+){0,4})`;
const afternoonErrand = new RegExp(
  String.raw`^(${day}) (?:sometime )?${errandPurpose} in the afternoon$`,
  "u",
);
const errandAfterAfternoon = new RegExp(
  String.raw`^(${day}) (?:in the )?afternoon ${errandPurpose}$`,
  "u",
);
const betweenTimes = /^between (.+) and (.+)$/u;
const fromTimes = /^from (.+) (?:to|until) (.+)$/u;
const explicitClock = new RegExp(`^(?:${STATED_CLOCK_MENTION_SOURCE})$`, "iu");
const spokenClock = new RegExp(
  String.raw`\b(${unitWords.slice(1, 13).join("|")})(?:\s+(?:oh\s+)?([a-z]+(?:[ -][a-z]+)?))?\s+([ap]\.?m\.?)(?![a-z])`,
  "giu",
);

function quantity(text: string): number {
  if (/^\d{1,3}$/.test(text)) return Number(text);
  const named = unitWords.indexOf(text);
  if (named > 0) return named;
  const [tens, unit] = text.split(/[ -]/u);
  const tensIndex = tensWords.findIndex(
    (word, index) => index >= 2 && word === tens,
  );
  const unitIndex = unit ? unitWords.indexOf(unit) : 0;
  return tensIndex >= 2 && unitIndex >= 0 && unitIndex < 10
    ? tensIndex * 10 + unitIndex
    : 0;
}

/** Converts explicitly disambiguated spoken clock phrases to the shared grammar. */
export function normalizeSpokenCalendarClocks(text: string): string {
  return text.replace(spokenClock, (phrase, hour, minutes, period) => {
    const minute = minutes ? quantity(minutes.toLowerCase()) : 0;
    if ((minutes && minute === 0) || minute > 59) return phrase;
    return `${quantity(hour.toLowerCase())}:${String(minute).padStart(2, "0")}${period}`;
  });
}

function slotClockOptions(text: string): StatedClockTime[] {
  if (explicitClock.test(text)) {
    const time = parseStatedClockTimes(text);
    return time.kind === "one" && !time.end ? [time.start] : [];
  }
  const numeric = /^(\d{1,2})(?::([0-5]\d))?$/u.exec(text);
  const hour = numeric ? Number(numeric[1]) : quantity(text);
  const minute = numeric ? Number(numeric[2] ?? 0) : 0;
  if (hour < 1 || hour > 23 || (!numeric && hour > 12)) return [];
  // A bare 1–12 is settled only if the complete same-day range admits one pair.
  return hour <= 12
    ? [
        { hour: hour % 12, minute },
        { hour: (hour % 12) + 12, minute },
      ]
    : [{ hour, minute }];
}

/** Parses a complete availability request for the already bound Calendar source. */
export function parseScopedCalendarSlotWindow(
  text: string,
  timeZone: string,
  observedAt: number,
  source: "builtin" | undefined,
  expectedTopic?: string,
):
  | {
      windowStart: string;
      windowEnd: string;
      durationMinutes: number;
      timeZone: string;
    }
  | undefined {
  const input = slotRequest.exec(
    normalizeText(text).replace(/[.!?]$/u, ""),
  )?.groups;
  const topic = input?.topic ?? input?.purpose;
  if (
    (!input?.duration && !input?.freeHour && !input?.halfHour) ||
    !input.window ||
    Boolean(input.builtin) !== (source === "builtin") ||
    (input.topic && (!input.builtin || input.purpose)) ||
    (expectedTopic !== undefined &&
      topic?.replace(/^(?:a|an) /u, "") !==
        normalizeText(expectedTopic).replace(/^(?:a|an) /u, "")) ||
    !Number.isFinite(observedAt) ||
    !isValidTimeZone(timeZone)
  )
    return;
  const now = new Date(observedAt);
  // A date in the label is another constraint, not a topic for the slot.
  if (
    topic &&
    (purposeConstraint.test(topic) ||
      parseExplicitLocalDate(topic, timeZone, now))
  )
    return;
  const durationMinutes = input.freeHour
    ? 60
    : input.halfHour
      ? 30
      : quantity(input.duration);
  if (
    durationMinutes < CALENDAR_NEW_SLOT_DURATION_MINUTES.min ||
    durationMinutes > CALENDAR_NEW_SLOT_DURATION_MINUTES.max
  )
    return;

  const leading = leadingDay.exec(input.window);
  const trailing = trailingDay.exec(input.window);
  const errand =
    afternoonErrand.exec(input.window) ??
    errandAfterAfternoon.exec(input.window);
  if (errand && purposeConstraint.test(errand[2])) return;
  const date = parseExplicitLocalDate(
    errand?.[1] ?? leading?.[1] ?? trailing?.[2] ?? "",
    timeZone,
    now,
  );
  const window = errand ? "afternoon" : (leading?.[2] ?? trailing?.[1]);
  if (!date || !window) return;
  // Plain afternoon availability uses the local noon–5 PM window.
  const range =
    window === "afternoon"
      ? [window, "noon", "5 pm"]
      : (betweenTimes.exec(window) ?? fromTimes.exec(window));
  if (!range?.[1] || !range[2]) return;
  const minuteOfDay = (time: StatedClockTime) => time.hour * 60 + time.minute;
  const starts = slotClockOptions(normalizeSpokenCalendarClocks(range[1]));
  const ends = slotClockOptions(normalizeSpokenCalendarClocks(range[2]));
  const pairs = starts.flatMap((start) =>
    ends
      .filter((end) => minuteOfDay(end) > minuteOfDay(start))
      .map((end) => [start, end] as const),
  );
  const [pair] = pairs;
  if (pairs.length !== 1 || !pair) return;
  try {
    const [startClock, endClock] = pair;
    const start = buildUtcDateFromLocalParts(
      timeZone,
      { ...date, ...startClock, second: 0 },
      "reject",
    );
    const end = buildUtcDateFromLocalParts(
      timeZone,
      { ...date, ...endClock, second: 0 },
      "reject",
    );
    if (
      start.getTime() < observedAt ||
      end.getTime() - start.getTime() < durationMinutes * 60_000
    )
      return;
    return {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      durationMinutes,
      timeZone,
    };
  } catch (error) {
    // Leave repeated or nonexistent local times to Calendar's clarification path.
    if (!(error instanceof CalendarLocalTimeError)) throw error;
  }
}
