/** Validates simple current-time answers against the CURRENT_TIME observation.
 * This deterministic guard handles only an unambiguous current-time question
 * and a standalone clock/date answer. Historical, hypothetical, multi-part,
 * and explanatory prose require model judgment and are left to normal review.
 *
 * The CURRENT_TIME provider puts the user's wall-clock time in the prompt with
 * an explicit "answer from this block only" instruction, and small models still
 * occasionally invent a date (live 2026-09-07 "2:16 pm EST"; live 2026-09-11
 * "Sunday, November 22, 2026 at 5:01:28 PM EST" against a block reading
 * "Friday, September 11, 2026 at 11:18:30 AM EDT"). When the user asked what
 * time or day it is, a standalone reply that names a date, weekday or clock
 * time the provider did not observe is ungrounded, and the provider's own
 * rendering is the complete answer.
 */

import { isValidTimeZone } from "@elizaos/contracts";
import { parseStatedClockTimes } from "@elizaos/contracts/stated-clock-time";
import {
  type ActionResult,
  activeCommittedEffectReceipts,
  isObjectRecord,
  type StateData,
} from "@elizaos/core";

const TIME_QUESTION_PATTERN =
  /^(?:what(?:['’]s|s| is)?\s+(?:the\s+)?(?:(?:current|local|today['’]s)\s+)?(?:time|day|date)(?:\s+is it)?|what day of the week is it)(?:\s+(?:right now|today|for me|please))*[?.!]*$/i;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTH_DAY_PATTERN =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi;
const CLOCK_PATTERN =
  /\b(\d{1,2})(?::(\d{2}))(?::\d{2})?\s*(AM|PM|a\.m\.|p\.m\.)/gi;
const WEEKDAY_PATTERN =
  /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi;

const CLOCK_TOLERANCE_MINUTES = 10;

/** A single current applied Calendar mutation owns an event-local clock range.
 * Single clocks, explicit zones and ambiguous/multi-event prose stay with ordinary review. This guard
 * never selects an event, changes it, or derives a time from the user's prose.
 */
export function calendarMutationTimeIsUngrounded(args: {
  reply: string;
  actionResults: readonly ActionResult[];
  agentId?: string;
}): boolean {
  if (!args.agentId) return false;
  const stated = parseStatedClockTimes(args.reply);
  if (stated.kind !== "one" || !stated.end) return false;
  // Explicit alternate zones are semantic claims, not event-local clocks.
  // Leave them to normal review rather than reinterpret them in the event zone.
  if (
    args.reply.split(/[\s,;()]+/).some((token) => {
      const zone = token.replace(/[.!?"'“”‘’]+$/g, "");
      return (
        zone !== "AM" &&
        zone !== "PM" &&
        (/^(?:UTC|GMT)[+-]/i.test(zone) || isValidTimeZone(zone))
      );
    })
  )
    return false;
  let active: ReturnType<typeof activeCommittedEffectReceipts>;
  try {
    active = activeCommittedEffectReceipts(
      args.actionResults.flatMap((result) => result.effectReceipts ?? []),
    );
  } catch {
    return false;
  }
  const events = args.actionResults.flatMap((result) => {
    const event = result.data?.event;
    if (
      result.success !== true ||
      !isObjectRecord(event) ||
      typeof event.id !== "string" ||
      event.agentId !== args.agentId ||
      event.isAllDay !== false ||
      typeof event.startAt !== "string" ||
      typeof event.endAt !== "string" ||
      typeof event.timezone !== "string" ||
      (typeof event.title === "string" &&
        parseStatedClockTimes(event.title).kind !== "none") ||
      !isObjectRecord(event.metadata)
    )
      return [];
    const version =
      typeof event.metadata.etag === "string"
        ? event.metadata.etag
        : event.updatedAt;
    if (
      typeof version !== "string" ||
      !active.some(
        (receipt) =>
          (receipt.operation === "calendar.event.create" ||
            receipt.operation === "calendar.event.update") &&
          receipt.resource.kind === "calendar.event" &&
          receipt.resource.id === event.id &&
          receipt.resource.version === version &&
          result.effectReceipts?.some(
            (own) => own.receiptId === receipt.receiptId,
          ),
      )
    )
      return [];
    const start = new Date(event.startAt),
      end = new Date(event.endAt);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end.getTime() <= start.getTime()
    )
      return [];
    try {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone: event.timezone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      });
      const minuteOfDay = (date: Date) => {
        const parts = format.formatToParts(date);
        return (
          Number(parts.find((part) => part.type === "hour")?.value) * 60 +
          Number(parts.find((part) => part.type === "minute")?.value)
        );
      };
      return [
        {
          key: JSON.stringify([
            event.id,
            version,
            event.startAt,
            event.endAt,
            event.timezone,
          ]),
          start: minuteOfDay(start),
          end: minuteOfDay(end),
        },
      ];
    } catch {
      return [];
    }
  });
  // Recovery may carry the same complete result in both captured and current
  // evidence. Only identical ID/version/timing copies are one observation.
  const unique = [
    ...new Map(events.map((event) => [event.key, event])).values(),
  ];
  const event = unique.at(0);
  if (unique.length !== 1 || !event) return false;
  const start = stated.start.hour * 60 + stated.start.minute;
  return (
    start !== event.start ||
    stated.end.hour * 60 + stated.end.minute !== event.end
  );
}

export interface ObservedCurrentTime {
  humanReadable: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  iso: string;
  timeZone: string;
  dayOfWeek?: string;
}

function readString(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The CURRENT_TIME provider's observation for this turn, if it ran. */
export function observedCurrentTime(
  providers: StateData["providers"] | undefined,
): ObservedCurrentTime | undefined {
  const entry = providers?.CURRENT_TIME as
    | { data?: unknown; values?: unknown }
    | undefined;
  if (!entry) return undefined;
  const humanReadable = readString(entry.data, "humanReadable");
  const date =
    readString(entry.data, "date") ?? readString(entry.values, "currentDate");
  const iso =
    readString(entry.data, "iso") ?? readString(entry.values, "currentTime");
  const timeZone =
    readString(entry.data, "timeZone") ?? readString(entry.values, "timeZone");
  if (!humanReadable || !date || !iso || !timeZone) return undefined;
  return {
    humanReadable,
    date,
    iso,
    timeZone,
    dayOfWeek:
      readString(entry.data, "dayOfWeek") ??
      readString(entry.values, "dayOfWeek"),
  };
}

export function requestAsksCurrentTime(request: string | undefined): boolean {
  return (
    typeof request === "string" && TIME_QUESTION_PATTERN.test(request.trim())
  );
}

function localParts(observed: ObservedCurrentTime): {
  month: number;
  day: number;
  year: number;
  minuteOfDay: number;
  weekday: number;
} | null {
  const instant = new Date(observed.iso);
  if (!Number.isFinite(instant.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: observed.timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    }).formatToParts(instant);
  } catch {
    // error-policy:J3 Invalid external timezone data is not an observation.
    return null;
  }
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_NAMES.indexOf(read("weekday").toLowerCase());
  return {
    month: Number(read("month")),
    day: Number(read("day")),
    year: Number(read("year")),
    minuteOfDay: Number(read("hour")) * 60 + Number(read("minute")),
    weekday,
  };
}

/**
 * True when the user asked for the current time or date and the reply names
 * a calendar date, weekday or clock time that does not match the provider's
 * observation. Replies without such statements are not judged here.
 */
export function statedTimeIsUngrounded(args: {
  reply: string;
  request?: string;
  providers?: StateData["providers"];
}): boolean {
  if (!requestAsksCurrentTime(args.request)) return false;
  const observed = observedCurrentTime(args.providers);
  if (!observed) return false;
  const local = localParts(observed);
  if (!local) return false;
  const reply = args.reply;
  // Restrict deterministic comparison to a standalone answer. Mentioning
  // tomorrow, an appointment, or a quoted weekday is not a claim about now.
  const remainder = reply
    .replace(MONTH_DAY_PATTERN, " ")
    .replace(WEEKDAY_PATTERN, " ")
    .replace(CLOCK_PATTERN, " ")
    .replace(
      /\b(?:it['’]s|it is|today is|currently|right now|about|at|for you|in your local time|your local time|AM|PM|EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT)\b/gi,
      " ",
    )
    .replace(/[\s,.!():]/g, "");
  if (remainder !== "") return false;
  for (const match of reply.matchAll(MONTH_DAY_PATTERN)) {
    const month = MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1;
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : undefined;
    if (month !== local.month || day !== local.day) return true;
    if (year !== undefined && year !== local.year) return true;
  }
  for (const match of reply.matchAll(WEEKDAY_PATTERN)) {
    if (WEEKDAY_NAMES.indexOf(match[1].toLowerCase()) !== local.weekday)
      return true;
  }
  for (const match of reply.matchAll(CLOCK_PATTERN)) {
    const hour12 = Number(match[1]) % 12;
    const minute = Number(match[2] ?? "0");
    const pm = /^p/i.test(match[3]);
    const stated = hour12 * 60 + minute + (pm ? 12 * 60 : 0);
    const drift = Math.abs(stated - local.minuteOfDay);
    if (Math.min(drift, 24 * 60 - drift) > CLOCK_TOLERANCE_MINUTES) return true;
  }
  return false;
}

/** The complete, provider-observed answer to a current-time question. */
export function groundedCurrentTimeReply(
  providers: StateData["providers"] | undefined,
): string | undefined {
  const observed = observedCurrentTime(providers);
  return observed ? `It's ${observed.humanReadable}.` : undefined;
}
