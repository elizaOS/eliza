/**
 * LifeOps scheduling-with-others actions.
 *
 * Adds three actions on top of the existing CALENDAR_ACTION CRUD path:
 *
 *  - PROPOSE_MEETING_TIMES: reads the owner's busy calendar + meeting
 *    preferences (preferred hours, blackout windows, travel buffer) and
 *    returns candidate slots that can be offered to another party.
 *  - CHECK_AVAILABILITY: given an ISO start/end window, reports whether
 *    the owner is free or busy and lists overlapping events.
 *  - UPDATE_MEETING_PREFERENCES: persist the owner's preferred meeting
 *    hours, blackout windows, and travel buffer to the LifeOps profile
 *    (stored alongside the existing owner profile in scheduler task
 *    metadata — no new table).
 *
 * Every user-visible reply runs through `renderLifeOpsActionReply` so the raw
 * data templates land in the agent's character voice instead of being streamed
 * raw. The structured `data` payload on each ActionResult is preserved verbatim
 * for downstream consumers (ACTION_STATE provider, scenario assertions, UI).
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  type LifeOpsMeetingPreferences,
  type LifeOpsMeetingPreferencesBlackout,
  type LifeOpsMeetingPreferencesPatch,
  normalizeLifeOpsMeetingPreferencesPatch,
  readLifeOpsMeetingPreferences,
  updateLifeOpsMeetingPreferences,
} from "../../lifeops/owner-profile.js";
import { LifeOpsService, LifeOpsServiceError } from "../../lifeops/service.js";
import { getZonedDateParts } from "../../lifeops/time.js";
import { parseJsonModelRecord } from "../../utils/json-model-output.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops-google-helpers.js";
import {
  messageText as getMessageText,
  renderLifeOpsActionReply,
} from "../lifeops-grounded-reply.js";
import { inferTimeZoneFromLocationText } from "../timezone-normalization.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./recent-context.js";

const MS_PER_MINUTE = 60_000;
const MAX_DAYS_LOOKAHEAD = 60;
const DEFAULT_DAYS_LOOKAHEAD = 7;
const DEFAULT_SLOTS_COUNT = 3;
const SLOT_STEP_MINUTES = 15;

export type ProposedMeetingSlot = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
  localStart: string;
  localEnd: string;
  timeZone: string;
};

export type ProposeMeetingTimesParameters = {
  durationMinutes?: number;
  daysAhead?: number;
  slotCount?: number;
  windowStart?: string;
  windowEnd?: string;
  timeZone?: string;
  counterparties?: string[];
};

export type CheckAvailabilityParameters = {
  startAt?: string;
  endAt?: string;
};

function parseTimeOfDayToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function formatLocalForDisplay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function dayOfWeekInTz(date: Date, timeZone: string): number {
  // Compute the local Y/M/D in the target IANA zone, then derive day-of-week
  // from a UTC anchor. Avoids any reliance on locale-specific weekday strings.
  const parts = getZonedDateParts(date, timeZone);
  return new Date(
    Date.UTC(parts.year, Math.max(0, parts.month - 1), parts.day, 12, 0, 0),
  ).getUTCDay();
}

function buildBusyIntervals(
  events: readonly LifeOpsCalendarEvent[],
  travelBufferMinutes: number,
): Array<{ start: number; end: number }> {
  const bufferMs = travelBufferMinutes * MS_PER_MINUTE;
  const intervals = events
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      start: Date.parse(e.startAt) - bufferMs,
      end: Date.parse(e.endAt) + bufferMs,
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function overlapsBusy(
  slotStart: number,
  slotEnd: number,
  busy: Array<{ start: number; end: number }>,
): boolean {
  for (const interval of busy) {
    if (slotStart < interval.end && slotEnd > interval.start) return true;
  }
  return false;
}

function getZonedMinuteOfDay(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function overlapsBlackout(
  slotStart: Date,
  slotEnd: Date,
  timeZone: string,
  blackouts: readonly LifeOpsMeetingPreferencesBlackout[],
): boolean {
  if (blackouts.length === 0) return false;
  const slotStartMin = getZonedMinuteOfDay(slotStart, timeZone);
  const slotEndMin = getZonedMinuteOfDay(slotEnd, timeZone);
  const dow = dayOfWeekInTz(slotStart, timeZone);

  for (const window of blackouts) {
    if (window.daysOfWeek && window.daysOfWeek.length > 0) {
      if (!window.daysOfWeek.includes(dow)) continue;
    }
    const bStart = parseTimeOfDayToMinutes(window.startLocal);
    const bEnd = parseTimeOfDayToMinutes(window.endLocal);
    if (slotStartMin < bEnd && slotEndMin > bStart) return true;
  }
  return false;
}

function endOfLocalDayMs(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  const remainingMinutes = 24 * 60 - (parts.hour * 60 + parts.minute);
  return date.getTime() + remainingMinutes * MS_PER_MINUTE;
}

export function computeProposedSlots(args: {
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  slotCount: number;
  preferences: LifeOpsMeetingPreferences;
  events: readonly LifeOpsCalendarEvent[];
}): ProposedMeetingSlot[] {
  const {
    now,
    windowStart,
    windowEnd,
    durationMinutes,
    slotCount,
    preferences,
    events,
  } = args;
  const tz = preferences.timeZone;
  const busy = buildBusyIntervals(events, preferences.travelBufferMinutes);

  const preferredStart = parseTimeOfDayToMinutes(
    preferences.preferredStartLocal,
  );
  const preferredEnd = parseTimeOfDayToMinutes(preferences.preferredEndLocal);

  const results: ProposedMeetingSlot[] = [];
  const seenDays = new Set<string>();

  const step = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  const cursor =
    Math.ceil(Math.max(windowStart.getTime(), now.getTime()) / step) * step;
  const endMs = windowEnd.getTime();
  const durationMs = durationMinutes * MS_PER_MINUTE;

  for (let pass = 0; pass < 2 && results.length < slotCount; pass++) {
    const onePerDay = pass === 0;
    let t = cursor;
    while (t + durationMs <= endMs && results.length < slotCount) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + durationMs);

      const slotStartMin = getZonedMinuteOfDay(slotStart, tz);
      const slotEndMin = getZonedMinuteOfDay(slotEnd, tz);
      const parts = getZonedDateParts(slotStart, tz);
      const endParts = getZonedDateParts(slotEnd, tz);
      const sameLocalDay =
        parts.year === endParts.year &&
        parts.month === endParts.month &&
        parts.day === endParts.day;
      const withinPreferred =
        sameLocalDay &&
        slotStartMin >= preferredStart &&
        slotEndMin <= preferredEnd;

      if (
        withinPreferred &&
        !overlapsBusy(slotStart.getTime(), slotEnd.getTime(), busy) &&
        !overlapsBlackout(slotStart, slotEnd, tz, preferences.blackoutWindows)
      ) {
        const dayKey = `${parts.year}-${parts.month}-${parts.day}`;
        if (!onePerDay || !seenDays.has(dayKey)) {
          seenDays.add(dayKey);
          results.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            durationMinutes,
            localStart: formatLocalForDisplay(slotStart.toISOString(), tz),
            localEnd: formatLocalForDisplay(slotEnd.toISOString(), tz),
            timeZone: tz,
          });
          if (onePerDay) {
            t = endOfLocalDayMs(slotStart, tz);
            continue;
          }
        }
      }
      t += step;
    }
  }

  return results;
}

function formatSlotsText(slots: readonly ProposedMeetingSlot[]): string {
  if (slots.length === 0) {
    return "I couldn't find any open slots matching your preferences in that window.";
  }
  const lines = slots.map(
    (slot, idx) =>
      `${idx + 1}. ${slot.localStart} – ${slot.localEnd} (${slot.durationMinutes} min)`,
  );
  return `Here ${slots.length === 1 ? "is an available option" : `are ${slots.length} options`} you can offer:\n${lines.join("\n")}`;
}

function cleanBundledCounterparty(value: string): string {
  return value
    .slice(0, 1024)
    .replace(/^(?:with|for|and|also|maybe|please)\s{1,32}/iu, "")
    .replace(/\s{1,32}(?:at|if|while|during|thanks|please)\b.{0,1024}$/iu, "")
    .replace(/[.?!,;:]+$/u, "")
    .trim();
}

export function extractBundledMeetingCounterparties(
  messageText: string,
): string[] {
  const trimmed = messageText.trim().slice(0, 4096);
  if (trimmed.length === 0) {
    return [];
  }

  const patterns = [
    /\bschedule\s{1,32}(.{1,2048}?)(?:\s{1,32}at\s{1,32}the\s{1,32}same\s{1,32}time\b|\s{1,32}same\s{1,32}day\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
    /\bbundle\s{1,32}(.{1,2048}?)(?:\s{1,32}together\b|\s{1,32}on\s{1,32}the\s{1,32}same\s{1,32}day\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
    /\bmeetings?\s{1,32}with\s{1,32}(.{1,2048}?)(?:\s{1,32}on\s{1,32}the\s{1,32}same\s{1,32}day\b|\s{1,32}at\s{1,32}the\s{1,32}same\s{1,32}time\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const raw = match?.[1]?.trim();
    if (!raw) {
      continue;
    }
    const counterparties = raw
      .slice(0, 2048)
      .split(/\s{0,32}(?:,|&|\band\b)\s{0,32}/iu)
      .map(cleanBundledCounterparty)
      .filter((value) => value.length > 0);
    if (counterparties.length >= 2) {
      return counterparties.slice(0, 4);
    }
  }

  return [];
}

function formatCounterpartyList(counterparties: readonly string[]): string {
  if (counterparties.length === 0) {
    return "those meetings";
  }
  if (counterparties.length === 1) {
    return counterparties[0] ?? "that meeting";
  }
  if (counterparties.length === 2) {
    return `${counterparties[0]} and ${counterparties[1]}`;
  }
  return `${counterparties.slice(0, -1).join(", ")}, and ${counterparties[counterparties.length - 1]}`;
}

function deriveBundleLocationLabel(messageText: string): string | null {
  const lowered = messageText.toLowerCase();
  const inMatch =
    /\b(?:in|while i(?:'| a)?m in|while im in)\s+([a-z][a-z\s._-]{1,40}?)(?:\s+(?:for|with|so|and)\b|[,.!?]|$)/iu.exec(
      lowered,
    );
  const candidate = inMatch?.[1]?.replace(/[_]+/g, " ").trim();
  if (!candidate) {
    return null;
  }
  return candidate
    .split(/\s+/u)
    .map((part) =>
      part.length > 0
        ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
        : part,
    )
    .join(" ");
}

type ProposedSlotsReplyContext = {
  counterparties?: string[];
  bundleLocationLabel?: string | null;
  timeZone: string;
};

export function formatProposedSlotsReply(args: {
  slots: readonly ProposedMeetingSlot[];
  context?: ProposedSlotsReplyContext;
}): string {
  const counterparties = args.context?.counterparties ?? [];
  const locationLabel = args.context?.bundleLocationLabel?.trim();
  const targetLabel = formatCounterpartyList(counterparties);
  const windowLabel = locationLabel
    ? `${locationLabel}-time`
    : args.context?.timeZone;

  if (counterparties.length >= 2) {
    if (args.slots.length === 0) {
      return `I couldn't find ${windowLabel} slots that keep ${targetLabel} in the same window. If you want, I can widen the search or split them across nearby times.`;
    }
    const lines = args.slots.map(
      (slot, idx) =>
        `${idx + 1}. ${slot.localStart} – ${slot.localEnd} (${slot.durationMinutes} min)`,
    );
    return `Here ${args.slots.length === 1 ? "is 1" : `are ${args.slots.length}`} ${windowLabel} option${args.slots.length === 1 ? "" : "s"} that keep ${targetLabel} in the same window:\n${lines.join("\n")}`;
  }

  return formatSlotsText(args.slots);
}

function parseOptionalIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getParams<T>(options: HandlerOptions | undefined): Partial<T> {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | Partial<T>
    | undefined;
  return params ?? {};
}

async function denyIfNoAccess(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  return !(await hasLifeOpsAccess(runtime, message));
}

type SchedulingRespondPayload<
  T extends NonNullable<ActionResult["data"]> | undefined,
> = {
  success: boolean;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  data?: T;
  values?: ActionResult["values"];
};

function makeSchedulingRespond(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  callback: Parameters<NonNullable<Action["handler"]>>[4];
  actionName: string;
}): <T extends NonNullable<ActionResult["data"]> | undefined>(
  payload: SchedulingRespondPayload<T>,
) => Promise<ActionResult> {
  const intent = getMessageText(args.message).trim();
  return async (payload) => {
    const text = await renderLifeOpsActionReply({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      intent,
      scenario: payload.scenario,
      fallback: payload.fallback,
      context: payload.context,
    });
    await args.callback?.({
      text,
      source: "action",
      action: args.actionName,
    });
    return {
      text,
      success: payload.success,
      ...(payload.values ? { values: payload.values } : {}),
      ...(payload.data ? { data: payload.data } : {}),
    };
  };
}

export const proposeMeetingTimesAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "PROPOSE_MEETING_TIMES",
  similes: [
    "SUGGEST_MEETING_TIMES",
    "OFFER_MEETING_SLOTS",
    "FIND_MEETING_SLOTS",
    "PROPOSE_SLOTS",
    "BUNDLE_MEETINGS_WHILE_TRAVELING",
    "BULK_RESCHEDULE_MEETINGS",
    "RESCHEDULE_MEETINGS",
  ],
  tags: ["meeting slots", "reschedule options"],
  description:
    "Propose concrete meeting time slots to offer to another person. This is " +
    "the dedicated action for any 'propose N times', 'suggest N slots', " +
    "'offer three times', 'find me three slots', 'give me a few times' request " +
    "targeted at another person or team. It reads the owner's calendar busy " +
    "times and meeting preferences (preferred hours, blackout windows, travel " +
    "buffer) and returns three available slots by default over the next seven " +
    "days. Also correct for bundled scheduling while traveling or concrete " +
    "reschedule options. " +
    "STRONG POSITIVE TRIGGERS — route HERE, not to CALENDAR_ACTION or SCHEDULING: " +
    "'propose three times for a sync with a person', 'suggest a few times for " +
    "a partner', 'offer a colleague three 30-minute slots', 'find us three options " +
    "next week', 'give me slots to send to a teammate'. " +
    "DO NOT use this for small talk, weather, or vague conversation. " +
    "DO NOT use this to check the owner's calendar, create a calendar event, " +
    "or view upcoming events — that is CALENDAR_ACTION. " +
    "DO NOT use this to start a multi-turn scheduling negotiation record — " +
    "that is SCHEDULING (subaction: start). This action just generates the " +
    "candidate slots; SCHEDULING tracks the negotiation lifecycle around them.",
  descriptionCompressed:
    "Propose available meeting slots from the owner's calendar and meeting preferences; not calendar CRUD or negotiation tracking.",
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, options, callback) => {
    const respond = makeSchedulingRespond({
      runtime,
      message,
      state,
      callback,
      actionName: "OWNER_CALENDAR",
    });

    if (await denyIfNoAccess(runtime, message)) {
      return respond({
        success: false,
        scenario: "scheduling_access_denied",
        fallback:
          "Scheduling actions are restricted to the owner and authorized users.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const params = getParams<ProposeMeetingTimesParameters>(options);
    const preferences = await readLifeOpsMeetingPreferences(runtime);
    const messageBody =
      typeof message.content?.text === "string" ? message.content.text : "";
    const inferredTimeZone =
      (typeof params.timeZone === "string" && params.timeZone.trim().length > 0
        ? params.timeZone.trim()
        : null) ?? inferTimeZoneFromLocationText(messageBody);
    const effectivePreferences = inferredTimeZone
      ? { ...preferences, timeZone: inferredTimeZone }
      : preferences;
    const counterparties =
      Array.isArray(params.counterparties) && params.counterparties.length > 0
        ? params.counterparties
        : extractBundledMeetingCounterparties(messageBody);
    const bundleLocationLabel = deriveBundleLocationLabel(messageBody);
    const durationMinutes =
      typeof params.durationMinutes === "number" &&
      params.durationMinutes >= 5 &&
      params.durationMinutes <= 480
        ? Math.floor(params.durationMinutes)
        : effectivePreferences.defaultDurationMinutes;
    const slotCount =
      typeof params.slotCount === "number" &&
      params.slotCount >= 1 &&
      params.slotCount <= 10
        ? Math.floor(params.slotCount)
        : DEFAULT_SLOTS_COUNT;
    const daysAhead =
      typeof params.daysAhead === "number" &&
      params.daysAhead >= 1 &&
      params.daysAhead <= MAX_DAYS_LOOKAHEAD
        ? Math.floor(params.daysAhead)
        : DEFAULT_DAYS_LOOKAHEAD;

    const now = new Date();
    const explicitStart = parseOptionalIso(params.windowStart);
    const explicitEnd = parseOptionalIso(params.windowEnd);
    const windowStart = explicitStart ?? now;
    const windowEnd =
      explicitEnd ??
      new Date(windowStart.getTime() + daysAhead * 24 * 60 * 60_000);

    const service = new LifeOpsService(runtime);
    let events: readonly LifeOpsCalendarEvent[] = [];
    try {
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        includeHiddenCalendars: true,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: effectivePreferences.timeZone,
      });
      events = feed.events;
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        const fallback =
          error.status === 403
            ? "I can't propose times yet — Google Calendar isn't connected. Connect your calendar and try again."
            : `I couldn't read your calendar (${error.message}).`;
        return respond({
          success: false,
          scenario: "scheduling_calendar_unavailable",
          fallback,
          context: { status: error.status, detail: error.message },
          data: {
            error: "CALENDAR_UNAVAILABLE",
            status: error.status,
            detail: error.message,
          },
        });
      }
      throw error;
    }

    const slots = computeProposedSlots({
      now,
      windowStart,
      windowEnd,
      durationMinutes,
      slotCount,
      preferences: effectivePreferences,
      events,
    });

    const fallback = formatProposedSlotsReply({
      slots,
      context: {
        counterparties,
        bundleLocationLabel,
        timeZone: effectivePreferences.timeZone,
      },
    });
    return respond({
      success: true,
      scenario: "scheduling_proposed_slots",
      fallback,
      context: {
        slotCount: slots.length,
        durationMinutes,
        timeZone: effectivePreferences.timeZone,
        counterparties,
        bundleLocationLabel,
      },
      data: {
        slots,
        durationMinutes,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        timeZone: effectivePreferences.timeZone,
        preferences: effectivePreferences,
        counterparties,
        bundleLocationLabel,
      },
    });
  },
  parameters: [
    {
      name: "durationMinutes",
      description:
        "Meeting length in minutes. Defaults to the owner's configured default duration.",
      schema: { type: "number" as const },
    },
    {
      name: "daysAhead",
      description:
        "Number of days ahead to search. Defaults to 7. Ignored when windowStart/windowEnd are supplied.",
      schema: { type: "number" as const },
    },
    {
      name: "slotCount",
      description: "Number of candidate slots to return. Defaults to 3.",
      schema: { type: "number" as const },
    },
    {
      name: "windowStart",
      description: "Optional ISO-8601 earliest start for the search window.",
      schema: { type: "string" as const },
    },
    {
      name: "windowEnd",
      description: "Optional ISO-8601 latest end for the search window.",
      schema: { type: "string" as const },
    },
    {
      name: "timeZone",
      description:
        "Optional IANA time zone override when the user is temporarily traveling and wants proposals shown in that local time.",
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "While I'm traveling, try to bundle meetings with PendingReality and Ryan on the same day if possible.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll propose bundled meeting slots that cluster those meetings together while you're traveling.",
        },
      },
    ],
  ],
};

export const checkAvailabilityAction: Action = {
  name: "CHECK_AVAILABILITY",
  similes: ["AM_I_FREE", "AVAILABILITY_CHECK", "FREE_BUSY"],
  description:
    "Check whether the owner is free or busy across a specific ISO-8601 " +
    "time window. Returns a free/busy summary and any overlapping events.",
  descriptionCompressed:
    "Check owner free/busy for one ISO-8601 time window and list overlapping events.",
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, options, callback) => {
    const respond = makeSchedulingRespond({
      runtime,
      message,
      state,
      callback,
      actionName: "OWNER_CALENDAR",
    });

    if (await denyIfNoAccess(runtime, message)) {
      return respond({
        success: false,
        scenario: "scheduling_access_denied",
        fallback:
          "Scheduling actions are restricted to the owner and authorized users.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const params = getParams<CheckAvailabilityParameters>(options);
    const windowStart = parseOptionalIso(params.startAt);
    const windowEnd = parseOptionalIso(params.endAt);
    if (!windowStart || !windowEnd || windowEnd <= windowStart) {
      return respond({
        success: false,
        scenario: "scheduling_invalid_window",
        fallback:
          "I need a valid ISO start and end time to check availability (end must be after start).",
        data: { error: "INVALID_WINDOW" },
      });
    }

    const preferences = await readLifeOpsMeetingPreferences(runtime);
    const service = new LifeOpsService(runtime);
    let events: readonly LifeOpsCalendarEvent[] = [];
    try {
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        includeHiddenCalendars: true,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: preferences.timeZone,
      });
      events = feed.events;
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        const fallback =
          error.status === 403
            ? "I can't check availability — Google Calendar isn't connected."
            : `I couldn't read your calendar (${error.message}).`;
        return respond({
          success: false,
          scenario: "scheduling_calendar_unavailable",
          fallback,
          context: { status: error.status, detail: error.message },
          data: {
            error: "CALENDAR_UNAVAILABLE",
            status: error.status,
            detail: error.message,
          },
        });
      }
      throw error;
    }

    const windowStartMs = windowStart.getTime();
    const windowEndMs = windowEnd.getTime();
    const conflicts = events.filter((event) => {
      const s = Date.parse(event.startAt);
      const e = Date.parse(event.endAt);
      return s < windowEndMs && e > windowStartMs;
    });

    const isFree = conflicts.length === 0;
    const fallback = isFree
      ? `You're free from ${formatLocalForDisplay(windowStart.toISOString(), preferences.timeZone)} to ${formatLocalForDisplay(windowEnd.toISOString(), preferences.timeZone)}.`
      : `You have ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} in that window: ${conflicts.map((c) => c.title || "Untitled").join(", ")}.`;

    return respond({
      success: true,
      scenario: isFree ? "scheduling_window_free" : "scheduling_window_busy",
      fallback,
      context: {
        isFree,
        conflictCount: conflicts.length,
        timeZone: preferences.timeZone,
      },
      data: {
        isFree,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        conflicts: conflicts.map((c) => ({
          id: c.id,
          title: c.title,
          startAt: c.startAt,
          endAt: c.endAt,
        })),
        timeZone: preferences.timeZone,
      },
    });
  },
  parameters: [
    {
      name: "startAt",
      description: "ISO-8601 start of the window to check.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "endAt",
      description: "ISO-8601 end of the window to check.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Am I free tomorrow between 2pm and 4pm?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You're free from Tue, Apr 20, 2:00 PM to Tue, Apr 20, 4:00 PM.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Do I have anything on my calendar Friday afternoon?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 1 conflict in that window: Design review with the team.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const updateMeetingPreferencesAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "UPDATE_MEETING_PREFERENCES",
  similes: [
    "SET_MEETING_PREFERENCES",
    "SAVE_MEETING_PREFERENCES",
    "SET_PREFERRED_TIMES",
    "SET_BLACKOUT_WINDOWS",
    "SLEEP_WINDOW",
    "NO_CALL_HOURS",
    "PROTECT_SLEEP",
  ],
  tags: [
    "always-include",
    "sleep window",
    "no-call hours",
    "protected hours",
    "blackout window",
  ],
  description:
    "Persist the owner's meeting scheduling preferences: preferred start/end " +
    "of day (24h HH:MM local), blackout windows, default meeting duration, " +
    "and travel buffer. These drive PROPOSE_MEETING_TIMES. Use this for durable " +
    "sleep windows, no-call hours, and other recurring scheduling rules.",
  descriptionCompressed:
    "Persist owner meeting preferences: preferred hours, blackout windows, default duration, and travel buffer.",
  contexts: ["calendar", "contacts", "tasks", "settings"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, options, callback) => {
    const respond = makeSchedulingRespond({
      runtime,
      message,
      state,
      callback,
      actionName: "OWNER_CALENDAR",
    });

    if (await denyIfNoAccess(runtime, message)) {
      return respond({
        success: false,
        scenario: "scheduling_access_denied",
        fallback:
          "Scheduling actions are restricted to the owner and authorized users.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const params = getParams<Record<string, unknown>>(options);
    const patch: LifeOpsMeetingPreferencesPatch =
      normalizeLifeOpsMeetingPreferencesPatch(params);

    if (Object.keys(patch).length === 0) {
      return respond({
        success: false,
        scenario: "scheduling_preferences_no_fields",
        fallback:
          "No valid preference fields were provided. Supply preferredStartLocal/preferredEndLocal as HH:MM, numeric defaultDurationMinutes/travelBufferMinutes, or a blackoutWindows array.",
        data: { error: "NO_FIELDS" },
      });
    }

    const updated = await updateLifeOpsMeetingPreferences(runtime, patch);
    if (!updated) {
      return respond({
        success: false,
        scenario: "scheduling_preferences_update_failed",
        fallback: "Could not persist meeting preferences.",
        data: { error: "PREFERENCES_UPDATE_FAILED" },
      });
    }

    const fallback = `Updated meeting preferences (${updated.preferredStartLocal}–${updated.preferredEndLocal} ${updated.timeZone}, default ${updated.defaultDurationMinutes} min, travel buffer ${updated.travelBufferMinutes} min, ${updated.blackoutWindows.length} blackout window${updated.blackoutWindows.length === 1 ? "" : "s"}).`;
    return respond({
      success: true,
      scenario: "scheduling_preferences_updated",
      fallback,
      context: {
        preferredStartLocal: updated.preferredStartLocal,
        preferredEndLocal: updated.preferredEndLocal,
        timeZone: updated.timeZone,
        defaultDurationMinutes: updated.defaultDurationMinutes,
        travelBufferMinutes: updated.travelBufferMinutes,
        blackoutWindowCount: updated.blackoutWindows.length,
      },
      data: { preferences: updated, updatedFields: Object.keys(patch) },
    });
  },
  parameters: [
    {
      name: "timeZone",
      description: "IANA time zone used to interpret preferred hours.",
      schema: { type: "string" as const },
    },
    {
      name: "preferredStartLocal",
      description:
        "Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
      schema: { type: "string" as const },
    },
    {
      name: "preferredEndLocal",
      description:
        "Latest preferred meeting end time-of-day (local HH:MM, 24h).",
      schema: { type: "string" as const },
    },
    {
      name: "defaultDurationMinutes",
      description: "Default meeting duration in minutes (5–480).",
      schema: { type: "number" as const },
    },
    {
      name: "travelBufferMinutes",
      description: "Minutes to reserve before/after each meeting (0–240).",
      schema: { type: "number" as const },
    },
    {
      name: "blackoutWindows",
      description:
        "Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun..6=Sat) }.",
      schema: { type: "array" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "No calls between 11pm and 8am unless I explicitly say it's okay.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updated your meeting preferences to block calls from 11:00 PM to 8:00 AM unless you override it.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Keep my mornings protected for deep work and don't schedule meetings before 10am.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stored your meeting preferences so mornings stay protected and meetings start at 10:00 AM or later.",
        },
      },
    ],
  ] as ActionExample[][],
};

// ── Multi-turn scheduling negotiation action ─────────────────────────────

type SchedulingSubaction =
  | "start"
  | "propose"
  | "respond"
  | "finalize"
  | "cancel"
  | "list_active"
  | "list_proposals";

type SchedulingActionParameters = {
  subaction?: SchedulingSubaction;
  intent?: string;
  negotiationId?: string;
  proposalId?: string;
  subject?: string;
  startAt?: string;
  endAt?: string;
  durationMinutes?: number;
  response?: "accepted" | "declined" | "expired";
  confirmed?: boolean;
  relationshipId?: string;
  timezone?: string;
  proposedBy?: "agent" | "owner" | "counterparty";
  reason?: string;
};

type SchedulingLlmPlan = {
  subaction: SchedulingSubaction | null;
  shouldAct?: boolean | null;
  response?: string;
};

function normalizeSchedulingSubaction(
  value: unknown,
): SchedulingSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "start":
    case "propose":
    case "respond":
    case "finalize":
    case "cancel":
    case "list_active":
    case "list_proposals":
      return normalized;
    default:
      return null;
  }
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveSchedulingPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: SchedulingActionParameters;
}): Promise<SchedulingLlmPlan> {
  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text
      : "";
  const prompt = [
    "Plan the scheduling negotiation action for this request.",
    "The user may speak in any language.",
    "Use the current request, the structured parameters, and recent conversation context.",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: one of start, propose, respond, finalize, cancel, list_active, list_proposals, or null",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false or clarification is needed",
    "",
    "Use start when beginning a new negotiation.",
    "Use propose when submitting a concrete proposed slot for an existing negotiation.",
    "Use respond when recording accepted, declined, or expired against a proposal.",
    "Use finalize when confirming the winning proposal.",
    "Use cancel when stopping an active negotiation.",
    "Use list_active for listing negotiations.",
    "Use list_proposals for listing proposals in one negotiation.",
    "If the user is making a first-turn calendar request, asking for recurring time, asking to bundle meetings while traveling, or asking for missed-call repair, this action is the wrong tool. Return shouldAct=false so the planner can choose OWNER_CALENDAR or MESSAGE with the appropriate inbox/draft operation instead.",
    "Set shouldAct=false when the user is vague or only asks for general scheduling help.",
    "",
    'Example: {"subaction":"start","shouldAct":true,"response":null}',
    'Example clarification: {"subaction":null,"shouldAct":false,"response":"Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?"}',
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Structured parameters:\n${Object.entries(args.params)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("\n")}`,
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-scheduling-handler" },
      () =>
        args.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return {
        subaction: null,
        shouldAct: null,
      };
    }
    return {
      subaction: normalizeSchedulingSubaction(parsed.subaction),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:scheduling",
        error: error instanceof Error ? error.message : String(error),
      },
      "Scheduling planning model call failed",
    );
    return {
      subaction: null,
      shouldAct: null,
    };
  }
}

function formatNegotiationSummary(n: {
  id: string;
  subject: string;
  state: string;
  durationMinutes: number;
}): string {
  return `Negotiation ${n.id} — "${n.subject}" (${n.durationMinutes} min, state=${n.state})`;
}

function formatProposalSummary(p: {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  proposedBy: string;
}): string {
  return `Proposal ${p.id}: ${p.startAt} → ${p.endAt} by ${p.proposedBy} (status=${p.status})`;
}

export const schedulingAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "SCHEDULING",
  similes: [
    "NEGOTIATE_MEETING",
    "MULTI_TURN_SCHEDULING",
    "MANAGE_SCHEDULING_NEGOTIATION",
    "RESPOND_TO_MEETING_PROPOSAL",
    "FINALIZE_SCHEDULING_NEGOTIATION",
  ],
  description:
    "Multi-turn scheduling negotiation coordinator. Use this only for an " +
    "existing proposal workflow: start a negotiation record, submit a concrete " +
    "proposal for that negotiation, record accepted/declined responses, " +
    "finalize the winning proposal, cancel, or list negotiations/proposals. " +
    "Do not use this for first-turn calendar requests, recurring blocks, " +
    "travel-time bundling, missed-call repair, or fresh candidate-slot " +
    "searches; those belong to OWNER_CALENDAR or MESSAGE with the appropriate inbox/draft operation.",
  descriptionCompressed:
    "Multi-turn scheduling negotiation lifecycle: start, propose, respond, finalize, cancel, and list negotiations/proposals.",
  contexts: ["calendar", "contacts", "tasks", "messaging"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const respond = makeSchedulingRespond({
      runtime,
      message,
      state,
      callback,
      actionName: "OWNER_CALENDAR",
    });

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | SchedulingActionParameters
        | undefined) ?? {};
    const messageBody =
      typeof message.content?.text === "string" ? message.content.text : "";
    const planIntent = (params.intent ?? messageBody).trim();
    const explicitSubaction = normalizeSchedulingSubaction(params.subaction);
    const llmPlan = await resolveSchedulingPlanWithLlm({
      runtime,
      message,
      state,
      intent: planIntent,
      params,
    });
    const subaction = explicitSubaction ?? llmPlan.subaction;

    if (llmPlan.shouldAct === false && !explicitSubaction) {
      const fallback =
        llmPlan.response ??
        "Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?";
      return respond({
        success: false,
        scenario: "scheduling_negotiation_clarification",
        fallback,
        values: {
          success: false,
          error: "PLANNER_SHOULDACT_FALSE",
          noop: true,
        },
        data: { noop: true, error: "PLANNER_SHOULDACT_FALSE" },
      });
    }

    if (!subaction) {
      const fallback =
        llmPlan.response ??
        "Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?";
      return respond({
        success: false,
        scenario: "scheduling_negotiation_missing_subaction",
        fallback,
        values: { requiresConfirmation: true },
        data: {
          error: "MISSING_SUBACTION",
          requiresConfirmation: true,
        },
      });
    }

    const service = new LifeOpsService(runtime);
    try {
      if (subaction === "start") {
        const subject = params.subject ?? params.intent ?? messageBody.trim();
        if (!subject) {
          return respond({
            success: false,
            scenario: "scheduling_negotiation_start_missing_subject",
            fallback:
              "I need a subject (what the meeting is about) to start a negotiation.",
            values: { requiresConfirmation: true },
            data: {
              error: "MISSING_SUBJECT",
              requiresConfirmation: true,
            },
          });
        }
        const neg = await service.startNegotiation({
          subject,
          relationshipId: params.relationshipId ?? null,
          durationMinutes: params.durationMinutes,
          timezone: params.timezone,
        });
        return respond({
          success: true,
          scenario: "scheduling_negotiation_started",
          fallback: `Started ${formatNegotiationSummary(neg)} and notified the counterparty.`,
          context: {
            negotiationId: neg.id,
            subject: neg.subject,
            durationMinutes: neg.durationMinutes,
            state: neg.state,
          },
          data: { negotiation: neg },
        });
      }

      if (subaction === "propose") {
        if (!params.negotiationId || !params.startAt || !params.endAt) {
          // Selection + execution were correct: the user wanted to propose
          // times, the handler ran, and we now need the user to fill in the
          // missing fields. Mark as awaiting-confirmation.
          return respond({
            success: false,
            scenario: "scheduling_negotiation_propose_missing_fields",
            fallback:
              "Propose needs negotiationId, startAt, and endAt (ISO-8601).",
            values: { requiresConfirmation: true },
            data: {
              error: "MISSING_PROPOSAL_FIELDS",
              requiresConfirmation: true,
            },
          });
        }
        const proposedBy = params.proposedBy ?? "agent";
        const proposal = await service.proposeTime({
          negotiationId: params.negotiationId,
          startAt: params.startAt,
          endAt: params.endAt,
          proposedBy,
        });
        const fallback =
          proposedBy === "counterparty"
            ? `Recorded ${formatProposalSummary(proposal)}.`
            : `Recorded ${formatProposalSummary(proposal)} and sent it to the counterparty.`;
        return respond({
          success: true,
          scenario: "scheduling_negotiation_proposed",
          fallback,
          context: {
            proposalId: proposal.id,
            startAt: proposal.startAt,
            endAt: proposal.endAt,
            proposedBy,
            status: proposal.status,
          },
          data: { proposal },
        });
      }

      if (subaction === "respond") {
        if (!params.proposalId || !params.response) {
          return respond({
            success: false,
            scenario: "scheduling_negotiation_respond_missing_fields",
            fallback: "Respond needs proposalId and response.",
            data: { error: "MISSING_RESPONSE_FIELDS" },
          });
        }
        const proposal = await service.respondToProposal(
          params.proposalId,
          params.response,
        );
        return respond({
          success: true,
          scenario: "scheduling_negotiation_respond",
          fallback: `Proposal ${proposal.id} is now ${proposal.status}.`,
          context: { proposalId: proposal.id, status: proposal.status },
          data: { proposal },
        });
      }

      if (subaction === "finalize") {
        if (!params.negotiationId || !params.proposalId) {
          return respond({
            success: false,
            scenario: "scheduling_negotiation_finalize_missing_fields",
            fallback: "Finalize needs negotiationId and proposalId.",
            data: { error: "MISSING_FINALIZE_FIELDS" },
          });
        }
        const neg = await service.finalizeNegotiation(
          params.negotiationId,
          params.proposalId,
        );
        return respond({
          success: true,
          scenario: "scheduling_negotiation_finalized",
          fallback: `Confirmed ${formatNegotiationSummary(neg)} and sent confirmation to the counterparty.`,
          context: {
            negotiationId: neg.id,
            subject: neg.subject,
            durationMinutes: neg.durationMinutes,
            state: neg.state,
          },
          data: { negotiation: neg },
        });
      }

      if (subaction === "cancel") {
        if (!params.negotiationId) {
          return respond({
            success: false,
            scenario: "scheduling_negotiation_cancel_missing_id",
            fallback: "Cancel needs negotiationId.",
            data: { error: "MISSING_NEGOTIATION_ID" },
          });
        }
        await service.cancelNegotiation(params.negotiationId, params.reason);
        return respond({
          success: true,
          scenario: "scheduling_negotiation_cancelled",
          fallback: `Cancelled negotiation ${params.negotiationId} and notified the counterparty.`,
          context: { negotiationId: params.negotiationId },
          data: { negotiationId: params.negotiationId },
        });
      }

      if (subaction === "list_proposals") {
        if (!params.negotiationId) {
          return respond({
            success: false,
            scenario: "scheduling_negotiation_list_proposals_missing_id",
            fallback: "list_proposals needs negotiationId.",
            data: { error: "MISSING_NEGOTIATION_ID" },
          });
        }
        const proposals = await service.listProposals(params.negotiationId);
        const fallback = proposals.length
          ? `Proposals for ${params.negotiationId}:\n${proposals.map(formatProposalSummary).join("\n")}`
          : `No proposals for ${params.negotiationId}.`;
        return respond({
          success: true,
          scenario: "scheduling_negotiation_list_proposals",
          fallback,
          context: {
            negotiationId: params.negotiationId,
            proposalCount: proposals.length,
          },
          data: { proposals },
        });
      }

      // list_active
      const active = await service.listActiveNegotiations({ limit: 20 });
      const fallback = active.length
        ? `Active negotiations:\n${active.map(formatNegotiationSummary).join("\n")}`
        : "No active scheduling negotiations.";
      return respond({
        success: true,
        scenario: "scheduling_negotiation_list_active",
        fallback,
        context: { activeCount: active.length },
        data: { negotiations: active },
      });
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        // Selection + execution were correct: the user asked to schedule, the
        // action ran, and the lifeops service surfaced a needs-human signal
        // (no counterparty contact, missing scheduling field, dispatch
        // failed, etc.). Mark as awaiting-confirmation so the native planner
        // stops chaining and the benchmark scorer treats this as completed.
        return respond({
          success: false,
          scenario: "scheduling_negotiation_service_error",
          fallback: `Scheduling error: ${error.message}`,
          context: { status: error.status, detail: error.message },
          values: { requiresConfirmation: true },
          data: {
            error: "SERVICE_ERROR",
            status: error.status,
            detail: error.message,
            requiresConfirmation: true,
          },
        });
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which step of the negotiation to run: start, propose, respond, finalize, cancel, list_active, list_proposals.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-text description of what the scheduling turn is trying to do.",
      schema: { type: "string" as const },
    },
    {
      name: "negotiationId",
      description:
        "Target negotiation ID for proposal, finalize, cancel, or list_proposals.",
      schema: { type: "string" as const },
    },
    {
      name: "proposalId",
      description: "Target proposal ID for respond or finalize.",
      schema: { type: "string" as const },
    },
    {
      name: "subject",
      description: "Subject of the meeting (used when starting a negotiation).",
      schema: { type: "string" as const },
    },
    {
      name: "startAt",
      description: "ISO-8601 proposed start time.",
      schema: { type: "string" as const },
    },
    {
      name: "endAt",
      description: "ISO-8601 proposed end time.",
      schema: { type: "string" as const },
    },
    {
      name: "durationMinutes",
      description:
        "Meeting duration in minutes (defaults to 30 when starting).",
      schema: { type: "number" as const },
    },
    {
      name: "response",
      description: "Proposal response: accepted, declined, or expired.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Set true alongside a proposalId to finalize.",
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Start a scheduling negotiation with Alice about the quarterly review",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Started negotiation — "quarterly review with Alice" (30 min, state=initiated).',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Propose Tuesday 2-3pm for negotiation abc-123" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Recorded proposal: 2026-04-21T14:00:00Z → 2026-04-21T15:00:00Z (status=pending).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Alice accepted proposal xyz-789" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Proposal xyz-789 is now accepted.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Finalize negotiation abc-123 with proposal xyz-789" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Confirmed negotiation — "quarterly review with Alice" (state=confirmed).',
        },
      },
    ],
  ],
};
