import { renderGroundedActionReply } from "@elizaos/agent/actions/grounded-action-reply";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "../../contracts/index.js";
import { resolveDefaultTimeZone } from "../../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../../lifeops/service.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "../../lifeops/time.js";
import {
  type CreateEventTravelIntent,
  computeCreateEventTravelBuffer,
  resolveCreateEventTravelIntent,
} from "../../travel-time/calendar-create.js";
import { TravelTimeUnavailableError } from "../../travel-time/service.js";
import {
  calendarReadUnavailableMessage,
  calendarWriteUnavailableMessage,
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  formatCalendarEventDateTime,
  formatCalendarFeed,
  formatNextEventContext,
  getGoogleCapabilityStatus,
  hasLifeOpsAccess,
  INTERNAL_URL,
  messageText,
  parseLifeOpsJsonRecord,
  runLifeOpsJsonModel,
  runLifeOpsTextModel,
  toActionData,
} from "../lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./recent-context.js";

type CalendarSubaction =
  | "feed"
  | "next_event"
  | "search_events"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "trip_window";

const CALENDAR_SUBACTION_VALUES: readonly CalendarSubaction[] = [
  "feed",
  "next_event",
  "search_events",
  "create_event",
  "update_event",
  "delete_event",
  "trip_window",
];

type RankedCalendarSearchCandidate = {
  event: LifeOpsCalendarEvent;
  score: number;
  matchedQueries: string[];
};

type CreateEventCalendarContext = {
  calendarTimeZone: string;
  feed: LifeOpsCalendarFeed;
};

export type CalendarLlmPlan = {
  subaction: CalendarSubaction | null;
  queries: string[];
  response?: string;
  shouldAct?: boolean | null;
  title?: string;
  tripLocation?: string;
  timeMin?: string;
  timeMax?: string;
  windowLabel?: string;
};

const MIN_CREATE_EVENT_DURATION_MINUTES = 15;
type CalendarReadSubaction =
  | "feed"
  | "next_event"
  | "search_events"
  | "trip_window"
  | null;
type CalendarLookupReadSubaction = "next_event" | "search_events";
type CalendarMutationSubaction =
  | "create_event"
  | "update_event"
  | "delete_event";

type CalendarActionParams = {
  subaction?: CalendarSubaction;
  intent?: string;
  title?: string;
  query?: string;
  queries?: string[];
  details?: Record<string, unknown>;
};

const PARAMETER_DOC_NOISE_PATTERN =
  /\b(?:actions?|params?|parameters?|query\?:string|subaction\?:string|details\?:object|required parameter|supported keys include|may include:|match against titles|structured calendar arguments|structured data when needed|boolean when)\b|\b\w+\?:\w+\b/i;

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

const MONTH_NAMES_SORTED = Object.keys(MONTH_MAP).sort(
  (a, b) => b.length - a.length,
);
const MONTH_NAME_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "i",
);

const WEEKDAY_NAMES_SORTED = Object.keys(WEEKDAY_MAP).sort(
  (a, b) => b.length - a.length,
);
const WEEKDAY_NAME_PATTERN = new RegExp(
  `\\b(?:(this|next)\\s+)?(${WEEKDAY_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
const CALENDAR_DETAIL_ALIASES = {
  calendarId: ["calendarid", "calendar_id"],
  timeMin: ["timemin", "time_min"],
  timeMax: ["timemax", "time_max"],
  timeZone: ["timezone", "time_zone"],
  forceSync: ["forcesync", "force_sync"],
  windowDays: ["windowdays", "window_days"],
  startAt: ["startat", "start_at"],
  endAt: ["endat", "end_at"],
  durationMinutes: ["durationminutes", "duration_minutes"],
  windowPreset: ["windowpreset", "window_preset"],
  eventId: [
    "eventid",
    "event_id",
    "externaleventid",
    "external_event_id",
    "googleeventid",
    "google_event_id",
  ],
  newTitle: ["newtitle", "new_title", "renameto", "rename_to"],
  description: ["desc", "summary", "body"],
  location: ["place", "venue"],
  travelOriginAddress: [
    "traveloriginaddress",
    "travel_origin_address",
    "travelorigin",
    "travel_origin",
    "originaddress",
    "origin_address",
    "departureaddress",
    "departure_address",
    "fromaddress",
    "from_address",
  ],
} as const;

function normalizeCalendarSubaction(value: unknown): CalendarSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "feed":
    case "next_event":
    case "search_events":
    case "create_event":
    case "update_event":
    case "delete_event":
    case "trip_window":
      return normalized;
    default:
      return null;
  }
}

function buildCalendarPlanFromParsed(
  parsed: Record<string, unknown>,
): CalendarLlmPlan | null {
  const subaction = normalizeCalendarSubaction(parsed.subaction);
  const shouldAct =
    normalizeShouldAct(parsed.shouldAct) ?? (subaction ? true : null);
  if (shouldAct === null) {
    return null;
  }

  if (shouldAct && subaction === null) {
    return null;
  }

  const tripLocation =
    typeof parsed.tripLocation === "string" &&
    parsed.tripLocation.trim().length > 0
      ? parsed.tripLocation.trim()
      : undefined;

  const rawQueries: Array<string | undefined> = [];
  if (typeof parsed.queries === "string" && parsed.queries.trim().length > 0) {
    for (const q of parsed.queries.split(/\s{0,256}\|\|\s{0,256}/)) {
      if (q.trim().length > 0) rawQueries.push(q.trim());
    }
  } else if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") rawQueries.push(value);
    }
  }
  if (typeof parsed.query === "string") rawQueries.push(parsed.query);
  if (typeof parsed.query1 === "string") rawQueries.push(parsed.query1);
  if (typeof parsed.query2 === "string") rawQueries.push(parsed.query2);
  if (typeof parsed.query3 === "string") rawQueries.push(parsed.query3);
  if (tripLocation) rawQueries.push(tripLocation);

  return {
    subaction,
    queries: dedupeCalendarQueries(rawQueries),
    response: normalizePlannerResponse(parsed.response),
    shouldAct,
    title:
      typeof parsed.title === "string" && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : undefined,
    tripLocation,
    timeMin: normalizeIsoDateTime(parsed.timeMin),
    timeMax: normalizeIsoDateTime(parsed.timeMax),
    windowLabel: normalizeWindowLabel(parsed.windowLabel ?? parsed.label),
  };
}

function formatCalendarPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "none";
    }
    return value
      .map(
        (entry, index) =>
          `item ${index + 1}: ${formatCalendarPromptValue(entry)}`,
      )
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "none";
    }
    return entries
      .map(([key, entry]) => `${key}: ${formatCalendarPromptValue(entry)}`)
      .join("\n");
  }
  return String(value);
}

function buildCalendarPlanRepairPrompt(args: {
  currentMessage: string;
  intent: string;
  recentConversation: string;
  rawResponse: string;
  timeZone: string;
  nowIso: string;
  localNow: string;
}): string {
  return [
    "Your last reply for the calendar planner was invalid or used the wrong schema.",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-op",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false, otherwise empty or null",
    "  queries: array or ||-delimited string of up to 3 search queries",
    "  title: optional event title",
    "  tripLocation: optional trip location",
    "  timeMin: optional ISO 8601 datetime",
    "  timeMax: optional ISO 8601 datetime",
    "  windowLabel: optional natural-language window label",
    "",
    "Use ONLY these exact subaction literals:",
    `  ${CALENDAR_SUBACTION_VALUES.join(", ")}, or null`,
    "Never invent synonyms such as edit_event, modify_event, reschedule_event, move_event, cancel_event, remove_event, agenda, or itinerary_window.",
    "Map rename/reschedule/move/edit requests for an existing event to update_event.",
    "Map delete/remove/cancel requests for an existing event to delete_event.",
    "The user may speak in any language.",
    "",
    `Current timezone: ${args.timeZone}`,
    `Current local datetime: ${args.localNow}`,
    `Current ISO datetime: ${args.nowIso}`,
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Previous invalid output:\n${args.rawResponse}`,
  ].join("\n");
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

function buildCalendarReplyOnlyFallback(
  subaction: CalendarSubaction | null,
): string {
  switch (subaction) {
    case "create_event":
      return "What event do you want to add, and when should it happen?";
    case "search_events":
    case "trip_window":
      return "What calendar event or trip do you want me to look up?";
    case "next_event":
    case "feed":
      return "Do you want today's schedule, your next event, or a specific event?";
    case "update_event":
      return "Which calendar event do you want to change, and what should change?";
    case "delete_event":
      return "Which calendar event do you want to delete?";
    default:
      return "What do you want to do on your calendar — check your schedule, find an event, or create one?";
  }
}

function normalizeCalendarReadSubaction(value: unknown): CalendarReadSubaction {
  if (
    value === "feed" ||
    value === "next_event" ||
    value === "search_events" ||
    value === "trip_window"
  ) {
    return value;
  }
  return null;
}

function normalizeCalendarLookupReadSubaction(
  value: unknown,
): CalendarLookupReadSubaction | null {
  if (value === "next_event" || value === "search_events") {
    return value;
  }
  return null;
}

function normalizeCalendarMutationSubaction(
  value: unknown,
): CalendarMutationSubaction | null {
  if (
    value === "create_event" ||
    value === "update_event" ||
    value === "delete_event"
  ) {
    return value;
  }
  return null;
}

function normalizeCalendarReadResolution(
  parsed: Record<string, unknown> | null | undefined,
): { subaction: CalendarReadSubaction; tripLocation?: string } | null {
  if (!parsed) {
    return null;
  }
  const subaction = normalizeCalendarReadSubaction(parsed.subaction);
  const tripLocation =
    typeof parsed.tripLocation === "string" &&
    parsed.tripLocation.trim().length > 0
      ? parsed.tripLocation.trim()
      : undefined;
  return { subaction, tripLocation };
}

function shouldDisambiguateCalendarReadPlan(
  plan: CalendarLlmPlan | null,
): boolean {
  if (plan === null) {
    return true;
  }
  return (
    plan.subaction === null ||
    plan.subaction === "feed" ||
    plan.subaction === "next_event" ||
    plan.subaction === "search_events"
  );
}

const CALENDAR_READ_DISAMBIGUATION_RULES = [
  "If the request combines a time window with a specific attendee, title, flight, appointment, or keyword, choose search_events, not feed.",
  "If the request asks what is happening while the user is in a place, choose trip_window, not search_events.",
  "If the request asks for the next or upcoming single meeting or appointment, choose next_event.",
  "If the request asks for a schedule, agenda, or list of events over a time window, choose feed.",
] as const;

const CALENDAR_MUTATION_INTENT_PATTERN =
  /\b(?:add|book|cancel|change|clear|create|delete|edit|move|put|remove|rename|reschedule|reserve|set\s+up|update)\b|\bschedule\s+(?:a|an|the|my|with|for|meeting|appointment|call|event|block|lunch|dinner)\b/i;
const CALENDAR_BROAD_FEED_PATTERN =
  /\b(?:agenda|week ahead)\b|\b(?:show|list|what(?:'s| is)).*(?:calendar|schedule|agenda)\b|\bwhat do i have (?:today|tomorrow|this|on)\b/i;
const CALENDAR_NEXT_EVENT_PATTERN =
  /\b(?:next|upcoming|nearest)\s+(?:appointment|event|meeting)\b|\bwhat(?:'s| is) my next\b/i;

function isSafeReadOnlyCalendarPlan(
  plan: CalendarLlmPlan | null,
  currentMessage: string,
  intent: string,
): boolean {
  if (!plan || plan.shouldAct === false || !plan.subaction) {
    return false;
  }
  const text = `${currentMessage}\n${intent}`;
  if (CALENDAR_MUTATION_INTENT_PATTERN.test(text)) {
    return false;
  }

  switch (plan.subaction) {
    case "feed":
      return CALENDAR_BROAD_FEED_PATTERN.test(text);
    case "next_event":
      return CALENDAR_NEXT_EVENT_PATTERN.test(text);
    case "search_events":
      return plan.queries.length > 0;
    case "trip_window":
      return Boolean(plan.tripLocation || plan.queries.length > 0);
    default:
      return false;
  }
}

async function disambiguateCalendarReadPlanWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarSubaction | null;
}): Promise<{
  subaction: CalendarReadSubaction;
  tripLocation?: string;
} | null> {
  const prompt = [
    "Resolve this calendar read intent.",
    "The user may speak in any language.",
    "Choose exactly one subaction: feed, next_event, search_events, trip_window, or null.",
    "feed means a schedule or agenda view over today, tomorrow, this week, or another time window.",
    "next_event means only the single next upcoming meeting or appointment.",
    "search_events means find calendar events by title, attendee, location, date, or keyword, including flights and appointments.",
    "trip_window means show what is happening while the user is in a place or during a trip/stay in that place.",
    ...CALENDAR_READ_DISAMBIGUATION_RULES,
    "Use null only when the request is not asking for a calendar read lookup.",
    "If you choose trip_window, also return tripLocation when the place is recoverable from the request or recent conversation.",
    "",
    "Examples:",
    "request: What's on my calendar today?",
    "subaction: feed",
    "",
    "request: What's my next meeting?",
    "subaction: next_event",
    "",
    "request: find my return flight",
    "subaction: search_events",
    "",
    "request: 東京にいる間、何がありますか？",
    "subaction: trip_window",
    "tripLocation: 東京",
    "",
    "request: Can you help me with my calendar?",
    "subaction: null",
    "",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: feed, next_event, search_events, trip_window, or null",
    "  tripLocation: optional string",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current planner candidate:\n${args.candidateSubaction ?? "null"}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_read_intent",
    failureMessage: "Calendar read disambiguation model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarReadResolution(result?.parsed);
}

async function resolveCalendarLookupBoundaryWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarLookupReadSubaction;
}): Promise<CalendarLookupReadSubaction | null> {
  const prompt = [
    "Resolve this calendar lookup intent.",
    "The user may speak in any language.",
    "Choose exactly one subaction: next_event or search_events.",
    "next_event means the user wants only the single nearest upcoming meeting, appointment, or event.",
    "search_events means the user wants to find matching calendar events by title, attendee, place, trip, keyword, or date.",
    CALENDAR_READ_DISAMBIGUATION_RULES[2],
    "If the request contains a specific attendee, title, flight, dentist, place, date constraint, or other lookup key, choose search_events, even when it also names a time window like today, tomorrow, or this week.",
    "",
    "Examples:",
    "request: What's my next meeting?",
    "subaction: next_event",
    "",
    "request: meetings with Sarah this week",
    "subaction: search_events",
    "",
    "request: 帰りの便を探して",
    "subaction: search_events",
    "",
    "Return JSON only as a single object with exactly this field:",
    "  subaction: next_event or search_events",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current candidate:\n${args.candidateSubaction}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_lookup_boundary",
    failureMessage: "Calendar lookup boundary model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarLookupReadSubaction(result?.parsed?.subaction);
}

async function resolveCalendarMutationBoundaryWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarSubaction | null;
}): Promise<CalendarMutationSubaction | null> {
  const prompt = [
    "Resolve whether this calendar request is a mutation.",
    "The user may speak in any language.",
    "Choose exactly one subaction: create_event, update_event, delete_event, or null.",
    "create_event means schedule, add, book, or put a new event on the calendar.",
    "update_event means rename, reschedule, move, or otherwise edit an existing event.",
    "delete_event means delete, cancel, remove, or clear an existing event.",
    "Use null when the request is only reading the calendar, searching events, discussing plans, or asking for general help.",
    "Prefer create_event when the user gives a time/date and asks to add or schedule a meeting or appointment, regardless of language.",
    "",
    "Examples:",
    "request: Schedule a meeting with Alex at 3pm tomorrow",
    "subaction: create_event",
    "",
    "request: Reschedule the dentist to Friday",
    "subaction: update_event",
    "",
    "request: Delete the team meeting tomorrow",
    "subaction: delete_event",
    "",
    "request: 今日の予定は何ですか？",
    "subaction: null",
    "",
    "Return JSON only as a single object with exactly this field:",
    "  subaction: create_event, update_event, delete_event, or null",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current candidate:\n${args.candidateSubaction ?? "null"}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_mutation_boundary",
    failureMessage: "Calendar mutation boundary model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarMutationSubaction(result?.parsed?.subaction);
}

async function finalizeCalendarPlan(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  plan: CalendarLlmPlan | null;
}): Promise<CalendarLlmPlan> {
  const { runtime, currentMessage, intent, recentConversation, plan } = args;
  if (plan?.shouldAct === false) {
    return plan;
  }
  const safeReadOnlyPlan = isSafeReadOnlyCalendarPlan(
    plan,
    currentMessage,
    intent,
  );
  if (
    !safeReadOnlyPlan &&
    plan?.subaction !== "create_event" &&
    plan?.subaction !== "update_event" &&
    plan?.subaction !== "delete_event"
  ) {
    const mutationSubaction = await resolveCalendarMutationBoundaryWithLlm({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      candidateSubaction: plan?.subaction ?? null,
    });
    if (mutationSubaction) {
      return {
        ...(plan ?? {
          queries: [],
          shouldAct: null,
        }),
        subaction: mutationSubaction,
        shouldAct: true,
        response: undefined,
      };
    }
  }

  if (safeReadOnlyPlan && plan) {
    return plan;
  }

  if (!shouldDisambiguateCalendarReadPlan(plan)) {
    return (
      plan ?? {
        subaction: null,
        queries: [],
        shouldAct: null,
      }
    );
  }

  const resolvedReadPlan = await disambiguateCalendarReadPlanWithLlm({
    runtime,
    currentMessage,
    intent,
    recentConversation,
    candidateSubaction: plan?.subaction ?? null,
  });

  if (resolvedReadPlan === null || resolvedReadPlan.subaction === null) {
    return (
      plan ?? {
        subaction: null,
        queries: [],
        shouldAct: null,
      }
    );
  }

  let finalReadSubaction = resolvedReadPlan.subaction;
  if (
    finalReadSubaction === "next_event" ||
    finalReadSubaction === "search_events"
  ) {
    const boundarySubaction = await resolveCalendarLookupBoundaryWithLlm({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      candidateSubaction: finalReadSubaction,
    });
    if (boundarySubaction) {
      finalReadSubaction = boundarySubaction;
    }
  }

  if (plan) {
    return {
      ...plan,
      subaction: finalReadSubaction,
      tripLocation: resolvedReadPlan.tripLocation ?? plan.tripLocation,
      queries: dedupeCalendarQueries([
        ...plan.queries,
        resolvedReadPlan.tripLocation,
      ]),
      shouldAct: true,
      response: undefined,
    };
  }

  return {
    subaction: finalReadSubaction,
    queries: dedupeCalendarQueries([resolvedReadPlan.tripLocation]),
    shouldAct: true,
    tripLocation: resolvedReadPlan.tripLocation,
  };
}

function buildCalendarServiceErrorFallback(
  error: LifeOpsServiceError,
  intent: string,
): string {
  const normalized = normalizeText(error.message);
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'")
  ) {
    return `I couldn't pin down the event time from "${intent}". Tell me the date and time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("startat is required") ||
    normalized.includes("windowpreset is not provided")
  ) {
    return "I still need the time for that event. Tell me when it should happen.";
  }
  if (normalized.includes("endat must be later than startat")) {
    return "That end time lands before the start. Give me the date and time again and I'll fix it.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "Calendar is rate-limited right now. Try again in a bit.";
  }
  return "I couldn't finish that calendar change yet. Tell me the event and timing again, and I'll try it a different way.";
}

function buildCalendarEventDisambiguationFallback(args: {
  action: "update" | "delete";
  candidates: LifeOpsCalendarEvent[];
  titleHint?: string;
}): string {
  const previewLines = args.candidates.slice(0, 3).map((candidate) => {
    const when = formatCalendarEventDateTime(candidate, {
      includeTimeZoneName: true,
    });
    return `- ${candidate.title} (${when})`;
  });
  const intro = args.titleHint
    ? `I found multiple events matching "${args.titleHint}".`
    : "I found multiple matching calendar events.";
  const suffix =
    args.candidates.length > 3
      ? ` There are ${args.candidates.length} matches total.`
      : "";
  return [
    intro,
    ...previewLines,
    `Tell me which one to ${args.action} by giving the title and date/time.${suffix}`,
  ].join("\n");
}

async function renderCalendarActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  return renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "calendar",
    scenario,
    fallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's phrasing for dates, times, ranges, and scheduling language when possible.",
      "Prefer phrases like tomorrow morning, next week, later, earlier, free, busy, or the user's own wording over robotic calendar language.",
      "Never surface raw ISO timestamps unless the user used raw ISO timestamps.",
      "Preserve all concrete event facts from the context and canonical fallback.",
      "If this is reply-only or a clarification, do not pretend you already changed the calendar.",
    ],
  });
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function wordCount(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }
  return normalized.split(" ").filter(Boolean).length;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function tokenVariants(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const variants = new Set([normalized]);
  if (normalized.endsWith("ies") && normalized.length > 3) {
    variants.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("es") && normalized.length > 4) {
    variants.add(normalized.slice(0, -2));
  }
  if (
    normalized.endsWith("s") &&
    !normalized.endsWith("ss") &&
    normalized.length > 3
  ) {
    variants.add(normalized.slice(0, -1));
  }
  return [...variants];
}

function tokenizeForSearch(value: string): string[] {
  return [...new Set(tokenize(value).flatMap((token) => tokenVariants(token)))];
}

function normalizeCalendarSearchQueryValue(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (PARAMETER_DOC_NOISE_PATTERN.test(value)) {
    return undefined;
  }

  const cleaned = normalizeText(value)
    .replace(/\b(?:actions?|params?|parameters?)\b[:;]*/g, "")
    .replace(
      /\b\w{1,128}\?:\w{1,128}(?:\s{1,32}\[[^\]]{1,256}\])?\s{0,32}-\s{0,32}/g,
      " ",
    )
    .replace(/\bsupported keys include\b.*$/g, "")
    .replace(/\bmatch against titles\b.*$/g, "")
    .replace(/\bstructured calendar arguments\b.*$/g, "")
    .replace(/[;:,]+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();

  if (
    !cleaned ||
    ["calendar", "schedule", "event", "events"].includes(cleaned) ||
    cleaned.length > 160 ||
    PARAMETER_DOC_NOISE_PATTERN.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function dedupeCalendarQueries(queries: Array<string | undefined>): string[] {
  const normalized = queries
    .map((query) => normalizeCalendarSearchQueryValue(query))
    .filter((query): query is string => Boolean(query));
  return [...new Set(normalized)];
}

function normalizeCalendarDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...details };
  const aliasMap = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CALENDAR_DETAIL_ALIASES)) {
    aliasMap.set(normalizeLookupKey(canonical), canonical);
    for (const alias of aliases) {
      aliasMap.set(normalizeLookupKey(alias), canonical);
    }
  }

  for (const [key, value] of Object.entries(details)) {
    const canonical = aliasMap.get(normalizeLookupKey(key));
    if (!canonical) {
      continue;
    }
    if (normalized[canonical] === undefined) {
      normalized[canonical] = value;
    }
  }

  return normalized;
}

function parseStateLine(line: string): { role: string; text: string } {
  const trimmed = line.trim();
  const timestampedMatch = trimmed.match(
    /^\d{1,2}:\d{2}\s+\([^)]+\)\s+\[[^\]]+\]\s+(\S+)\s*:\s*(.*)/,
  );
  if (timestampedMatch) {
    const role = timestampedMatch[1];
    const text = timestampedMatch[2];
    if (!role || text === undefined) {
      return { role: "", text: trimmed };
    }
    return {
      role: role.toLowerCase(),
      text: text.trim(),
    };
  }

  const simpleMatch = trimmed.match(
    /^(user|assistant|system|owner|admin|\S+)\s*:\s*(.*)/i,
  );
  if (simpleMatch) {
    const role = simpleMatch[1];
    const text = simpleMatch[2];
    if (!role || text === undefined) {
      return { role: "", text: trimmed };
    }
    return {
      role: role.toLowerCase(),
      text: text.trim(),
    };
  }

  return { role: "", text: trimmed };
}

function planningConversationLines(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;
  const raw =
    typeof values?.recentMessages === "string"
      ? values.recentMessages
      : typeof stateRecord.text === "string"
        ? stateRecord.text
        : "";
  if (!raw) {
    return [];
  }

  return raw
    .split(/\n+/)
    .map((line) => parseStateLine(line))
    .filter((line) => line.role.length > 0 && line.text.length > 0)
    .map((line) => `${line.role}: ${line.text}`);
}

function resolveCalendarIntentInput(
  paramsIntent: string | undefined,
  message: Parameters<typeof messageText>[0],
): string {
  return paramsIntent?.trim() || messageText(message).trim();
}

function resolveStructuredCalendarSubaction(
  params: CalendarActionParams,
  details: Record<string, unknown> | undefined,
): CalendarSubaction | null {
  if (detailString(details, "eventId")) {
    if (
      detailString(details, "newTitle") ||
      detailString(details, "title") ||
      detailString(details, "startAt") ||
      detailString(details, "endAt") ||
      detailString(details, "description") ||
      detailString(details, "location")
    ) {
      return "update_event";
    }
    return "delete_event";
  }

  if (
    detailString(details, "startAt") ||
    detailString(details, "endAt") ||
    detailString(details, "windowPreset") ||
    detailNumber(details, "durationMinutes") ||
    params.title ||
    detailString(details, "title")
  ) {
    return "create_event";
  }

  if (
    params.query ||
    detailString(details, "query") ||
    (params.queries?.length ?? 0) > 0 ||
    (detailArray(details, "queries")?.length ?? 0) > 0 ||
    detailString(details, "timeMin") ||
    detailString(details, "timeMax")
  ) {
    return "search_events";
  }

  return null;
}

function parseExplicitLocalDate(
  value: string,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  const normalized = normalizeText(value);
  const localToday = getZonedDateParts(new Date(), timeZone);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
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
    return {
      year: monthNameMatch[3] ? Number(monthNameMatch[3]) : localToday.year,
      month,
      day: Number(monthNameMatch[2]),
    };
  }

  const numericMatch = normalized.match(
    /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const yearRaw = numericMatch[3];
    const parsedYear =
      yearRaw === undefined
        ? localToday.year
        : yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw);
    return {
      year: parsedYear,
      month: Number(numericMatch[1]),
      day: Number(numericMatch[2]),
    };
  }

  const weekdayMatch = normalized.match(WEEKDAY_NAME_PATTERN);
  if (weekdayMatch) {
    const qualifier = normalizeLookupKey(weekdayMatch[1] ?? "");
    const weekdayKey = normalizeLookupKey(weekdayMatch[2] ?? "");
    const targetWeekday = WEEKDAY_MAP[weekdayKey];
    if (targetWeekday !== undefined) {
      const currentWeekday = new Date(
        Date.UTC(
          localToday.year,
          Math.max(0, localToday.month - 1),
          localToday.day,
          12,
          0,
          0,
        ),
      ).getUTCDay();
      let delta = (targetWeekday - currentWeekday + 7) % 7;
      if (qualifier === "next") {
        delta = delta === 0 ? 7 : delta + 7;
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

  return null;
}

function resolveCalendarTimeZone(
  details: Record<string, unknown> | undefined,
): string {
  return detailString(details, "timeZone") ?? resolveDefaultTimeZone();
}

type LocalDateOnly = Pick<
  ReturnType<typeof getZonedDateParts>,
  "year" | "month" | "day"
>;

function getLocalTodayDate(timeZone: string): LocalDateOnly {
  const localNow = getZonedDateParts(new Date(), timeZone);
  return {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
}

function buildLocalDateRange(
  timeZone: string,
  startDate: LocalDateOnly,
  endDateExclusive: LocalDateOnly,
  options?: {
    startHour?: number;
    startMinute?: number;
    endHour?: number;
    endMinute?: number;
  },
): { timeMin: string; timeMax: string } {
  return {
    timeMin: buildUtcDateFromLocalParts(timeZone, {
      year: startDate.year,
      month: startDate.month,
      day: startDate.day,
      hour: options?.startHour ?? 0,
      minute: options?.startMinute ?? 0,
      second: 0,
    }).toISOString(),
    timeMax: buildUtcDateFromLocalParts(timeZone, {
      year: endDateExclusive.year,
      month: endDateExclusive.month,
      day: endDateExclusive.day,
      hour: options?.endHour ?? 0,
      minute: options?.endMinute ?? 0,
      second: 0,
    }).toISOString(),
  };
}

function buildLocalDayRange(
  timeZone: string,
  startOffsetDays: number,
  endOffsetDaysExclusive: number,
): { timeMin: string; timeMax: string } {
  const localToday = getLocalTodayDate(timeZone);
  return buildLocalDateRange(
    timeZone,
    addDaysToLocalDate(localToday, startOffsetDays),
    addDaysToLocalDate(localToday, endOffsetDaysExclusive),
  );
}

function formatExplicitCalendarDateLabel(args: {
  date: LocalDateOnly;
  timeZone: string;
}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: args.timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(
    buildUtcDateFromLocalParts(args.timeZone, {
      year: args.date.year,
      month: args.date.month,
      day: args.date.day,
      hour: 12,
      minute: 0,
      second: 0,
    }),
  );
}

function resolveExplicitCalendarDateWindow(
  intent: string,
  timeZone: string,
): { timeMin: string; timeMax: string; label: string } | null {
  const explicitDate = parseExplicitLocalDate(intent, timeZone);
  if (!explicitDate) {
    return null;
  }
  return {
    ...buildLocalDateRange(
      timeZone,
      explicitDate,
      addDaysToLocalDate(explicitDate, 1),
    ),
    label: `on ${formatExplicitCalendarDateLabel({
      date: explicitDate,
      timeZone,
    })}`,
  };
}

function compareLocalDates(left: LocalDateOnly, right: LocalDateOnly): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }
  if (left.month !== right.month) {
    return left.month - right.month;
  }
  return left.day - right.day;
}

function resolveCreateEventCalendarTimeZone(
  details: Record<string, unknown> | undefined,
  feed: LifeOpsCalendarFeed | null | undefined,
  fallbackTimeZone: string,
): string {
  const explicitTimeZone = detailString(details, "timeZone");
  if (explicitTimeZone) {
    return explicitTimeZone;
  }

  const counts = new Map<string, number>();
  for (const event of feed?.events ?? []) {
    const eventTimeZone =
      typeof event.timezone === "string" ? event.timezone.trim() : "";
    if (!eventTimeZone) {
      continue;
    }
    counts.set(eventTimeZone, (counts.get(eventTimeZone) ?? 0) + 1);
  }

  let winner = fallbackTimeZone;
  let winnerCount = 0;
  for (const [timeZone, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = timeZone;
      winnerCount = count;
    }
  }
  return winner;
}

function formatCreateEventCalendarContext(
  context: CreateEventCalendarContext | null,
): string {
  if (!context) {
    return "(calendar context unavailable)";
  }

  const lines = [
    `Calendar timezone: ${context.calendarTimeZone}`,
    `Context window: ${context.feed.timeMin} to ${context.feed.timeMax}`,
  ];

  if (context.feed.events.length === 0) {
    lines.push("(no upcoming events in the next 2 weeks)");
    return lines.join("\n");
  }

  const visibleEvents = context.feed.events.slice(0, 40);
  for (const event of visibleEvents) {
    const when = event.isAllDay
      ? formatCalendarMoment(event)
      : formatCalendarEventDateTime(event, {
          includeTimeZoneName: true,
          includeYear: true,
        });
    lines.push(
      `- ${when} — ${event.title}${event.location ? ` @ ${event.location}` : ""}`,
    );
  }
  if (context.feed.events.length > visibleEvents.length) {
    lines.push(
      `... ${context.feed.events.length - visibleEvents.length} more upcoming events omitted`,
    );
  }
  return lines.join("\n");
}

// Fallback default duration when neither the user nor the LLM supplies one.
// Specialization (personal vs work vs prep) is now handled by the LLM during
// inferCreateEventDetails — never by English keyword regex.
function resolveSuggestedCreateEventDurationMinutes(): number {
  return 60;
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function overlapsBusyWindow(
  startMinute: number,
  durationMinutes: number,
  busyWindows: Array<{ startMinute: number; endMinute: number }>,
): boolean {
  const endMinute = startMinute + durationMinutes;
  return busyWindows.some(
    (window) =>
      startMinute < window.endMinute && endMinute > window.startMinute,
  );
}

function busyWindowsForLocalDate(
  events: LifeOpsCalendarEvent[],
  targetDate: LocalDateOnly,
  timeZone: string,
): Array<{ startMinute: number; endMinute: number }> {
  const windows: Array<{ startMinute: number; endMinute: number }> = [];

  for (const event of events) {
    if (event.isAllDay) {
      continue;
    }
    const start = getZonedDateParts(new Date(event.startAt), timeZone);
    const end = getZonedDateParts(new Date(event.endAt), timeZone);
    const startDate = { year: start.year, month: start.month, day: start.day };
    const endDate = { year: end.year, month: end.month, day: end.day };

    if (
      compareLocalDates(endDate, targetDate) < 0 ||
      compareLocalDates(startDate, targetDate) > 0
    ) {
      continue;
    }

    const startMinute =
      compareLocalDates(startDate, targetDate) < 0
        ? 0
        : start.hour * 60 + start.minute;
    const endMinute =
      compareLocalDates(endDate, targetDate) > 0
        ? 24 * 60
        : Math.max(startMinute + 1, end.hour * 60 + end.minute);

    windows.push({ startMinute, endMinute });
  }

  return windows.sort((left, right) => left.startMinute - right.startMinute);
}

// Preferred slot ordering for tentative event scheduling. Locale-agnostic:
// weekdays prefer mid-morning through evening, weekends prefer late morning
// and afternoon. Specific category preferences (personal vs work) are now
// supplied by the LLM via inferCreateEventDetails — not by English regex.
function resolvePreferredCreateEventMinutes(
  targetDate: LocalDateOnly,
): number[] {
  const weekday = getWeekdayForLocalDate(targetDate);
  return weekday === 0 || weekday === 6
    ? [10 * 60, 13 * 60, 18 * 60]
    : [9 * 60, 11 * 60, 14 * 60, 16 * 60, 19 * 60];
}

function chooseSuggestedCreateEventMinute(args: {
  busyWindows: Array<{ startMinute: number; endMinute: number }>;
  preferredMinutes: number[];
  durationMinutes: number;
}): number | null {
  for (const minute of args.preferredMinutes) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  const latestEnd = Math.max(
    0,
    ...args.busyWindows.map((window) => window.endMinute),
  );
  const afterLastEvent = roundUpToStep(latestEnd + 15, 15);
  if (
    afterLastEvent + args.durationMinutes <= 22 * 60 &&
    !overlapsBusyWindow(afterLastEvent, args.durationMinutes, args.busyWindows)
  ) {
    return afterLastEvent;
  }

  for (let minute = 8 * 60; minute <= 21 * 60; minute += 30) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  return null;
}

function suggestCreateEventStartAt(args: {
  currentMessage: string;
  intent: string;
  title: string;
  calendarContext: CreateEventCalendarContext | null;
}): { startAt: string; timeZone: string } | null {
  if (!args.calendarContext) {
    return null;
  }

  const targetDate =
    parseExplicitLocalDate(
      args.currentMessage,
      args.calendarContext.calendarTimeZone,
    ) ??
    parseExplicitLocalDate(args.intent, args.calendarContext.calendarTimeZone);
  if (!targetDate) {
    return null;
  }

  const durationMinutes = resolveSuggestedCreateEventDurationMinutes();
  const busyWindows = busyWindowsForLocalDate(
    args.calendarContext.feed.events,
    targetDate,
    args.calendarContext.calendarTimeZone,
  );
  const startMinute = chooseSuggestedCreateEventMinute({
    busyWindows,
    preferredMinutes: resolvePreferredCreateEventMinutes(targetDate),
    durationMinutes,
  });
  if (startMinute === null) {
    return null;
  }

  return {
    startAt: buildUtcDateFromLocalParts(args.calendarContext.calendarTimeZone, {
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
      second: 0,
    }).toISOString(),
    timeZone: args.calendarContext.calendarTimeZone,
  };
}

async function loadCreateEventCalendarContext(
  service: LifeOpsService,
  details: Record<string, unknown> | undefined,
  hasCalendarRead: boolean,
): Promise<CreateEventCalendarContext | null> {
  if (!hasCalendarRead) {
    return null;
  }

  const requestTimeZone = resolveCalendarTimeZone(details);
  const feed = await service.getCalendarFeed(INTERNAL_URL, {
    includeHiddenCalendars: true,
    mode: detailString(details, "mode") as
      | "local"
      | "remote"
      | "cloud_managed"
      | undefined,
    side: detailString(details, "side") as "owner" | "agent" | undefined,
    grantId: detailString(details, "grantId"),
    calendarId: detailString(details, "calendarId"),
    timeZone: requestTimeZone,
    forceSync: detailBoolean(details, "forceSync"),
    ...buildLocalDayRange(requestTimeZone, 0, 14),
  });

  if (!feed || !Array.isArray(feed.events)) {
    return null;
  }

  return {
    calendarTimeZone: resolveCreateEventCalendarTimeZone(
      details,
      feed,
      requestTimeZone,
    ),
    feed,
  };
}

function normalizeIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeWindowLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : undefined;
}

function utcDateOnly(value: Date): LocalDateOnly {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function isUtcStartOfDay(value: Date): boolean {
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

function isUtcEndOfDay(value: Date): boolean {
  return (
    value.getUTCHours() === 23 &&
    value.getUTCMinutes() === 59 &&
    value.getUTCSeconds() === 59
  );
}

function resolveCalendarLlmLocalDateWindow(
  timeMin: string,
  timeMax: string,
  timeZone: string,
): { timeMin: string; timeMax: string } | null {
  const start = new Date(timeMin);
  const end = new Date(timeMax);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  if (!isUtcStartOfDay(start)) {
    return null;
  }

  const startDate = utcDateOnly(start);
  const endExclusiveDate = isUtcStartOfDay(end)
    ? utcDateOnly(end)
    : isUtcEndOfDay(end)
      ? addDaysToLocalDate(utcDateOnly(end), 1)
      : null;
  if (!endExclusiveDate) {
    return null;
  }
  if (compareLocalDates(endExclusiveDate, startDate) <= 0) {
    return null;
  }
  return buildLocalDateRange(timeZone, startDate, endExclusiveDate);
}

function resolveCalendarLlmWindow(
  timeZone: string,
  llmPlan: CalendarLlmPlan | undefined,
): { timeMin: string; timeMax: string; label: string } | null {
  const timeMin = normalizeIsoDateTime(llmPlan?.timeMin);
  const timeMax = normalizeIsoDateTime(llmPlan?.timeMax);
  if (!timeMin || !timeMax) {
    return null;
  }

  const minMs = Date.parse(timeMin);
  const maxMs = Date.parse(timeMax);
  const spanMs = maxMs - minMs;
  if (
    !Number.isFinite(spanMs) ||
    spanMs <= 0 ||
    spanMs > 370 * 24 * 60 * 60 * 1000
  ) {
    return null;
  }

  return {
    ...(resolveCalendarLlmLocalDateWindow(timeMin, timeMax, timeZone) ?? {
      timeMin,
      timeMax,
    }),
    label:
      normalizeWindowLabel(llmPlan?.windowLabel) ?? "for the requested window",
  };
}

// Wide window used by update_event / delete_event lookups when the user
// gave no time hint. Reaches 1 year back and 5 years forward — far enough
// to find a future birthday or a recent past meeting without scanning the
// entire account.
function buildWideLookupRange(timeZone: string): {
  timeMin: string;
  timeMax: string;
} {
  return buildLocalDayRange(timeZone, -365, 365 * 5);
}

function resolveCalendarWindow(
  intent: string,
  details: Record<string, unknown> | undefined,
  forSearch: boolean,
  llmPlan?: CalendarLlmPlan,
): {
  request: GetLifeOpsCalendarFeedRequest;
  label: string;
  explicitWindow: boolean;
} {
  const timeMin = detailString(details, "timeMin");
  const timeMax = detailString(details, "timeMax");
  const calendarId = detailString(details, "calendarId");
  const timeZone = resolveCalendarTimeZone(details);
  const forceSync = detailBoolean(details, "forceSync");
  if (timeMin || timeMax) {
    return {
      request: {
        calendarId,
        timeMin: timeMin ?? undefined,
        timeMax: timeMax ?? undefined,
        timeZone,
        forceSync,
      },
      label: detailString(details, "label") ?? "for the requested window",
      explicitWindow: true,
    };
  }

  const llmWindow = resolveCalendarLlmWindow(timeZone, llmPlan);
  if (llmWindow) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: llmWindow.timeMin,
        timeMax: llmWindow.timeMax,
      },
      label: llmWindow.label,
      explicitWindow: true,
    };
  }

  const explicitDateWindow = resolveExplicitCalendarDateWindow(
    intent,
    timeZone,
  );
  if (explicitDateWindow) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: explicitDateWindow.timeMin,
        timeMax: explicitDateWindow.timeMax,
      },
      label: explicitDateWindow.label,
      explicitWindow: true,
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  if (forSearch) {
    const days = windowDays && windowDays > 0 ? Math.min(windowDays, 90) : 30;
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 0, days),
      },
      label: `across the next ${days} days`,
      explicitWindow: false,
    };
  }

  return {
    request: {
      calendarId,
      timeZone,
      forceSync,
      ...buildLocalDayRange(timeZone, 0, 1),
    },
    label: "today",
    explicitWindow: false,
  };
}

function resolveTripWindowRequest(
  details: Record<string, unknown> | undefined,
  llmPlan?: CalendarLlmPlan,
): GetLifeOpsCalendarFeedRequest {
  const timeMin = detailString(details, "timeMin");
  const timeMax = detailString(details, "timeMax");
  const calendarId = detailString(details, "calendarId");
  const timeZone = resolveCalendarTimeZone(details);
  const forceSync = detailBoolean(details, "forceSync");

  if (timeMin || timeMax) {
    return {
      calendarId,
      timeMin: timeMin ?? undefined,
      timeMax: timeMax ?? undefined,
      timeZone,
      forceSync,
    };
  }

  const llmWindow = resolveCalendarLlmWindow(timeZone, llmPlan);
  if (llmWindow) {
    return {
      calendarId,
      timeZone,
      forceSync,
      timeMin: llmWindow.timeMin,
      timeMax: llmWindow.timeMax,
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  const days = windowDays && windowDays > 0 ? Math.min(windowDays, 120) : 60;
  return {
    calendarId,
    timeZone,
    forceSync,
    ...buildLocalDayRange(timeZone, 0, days),
  };
}

function eventDateSearchTerms(event: LifeOpsCalendarEvent): Set<string> {
  const formatter = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      ...options,
    }).format(new Date(event.startAt));

  const monthLong = normalizeText(
    formatter({ month: "long" }).replace(/\./g, ""),
  );
  const monthShort = normalizeText(
    formatter({ month: "short" }).replace(/\./g, ""),
  );
  const weekdayLong = normalizeText(formatter({ weekday: "long" }));
  const weekdayShort = normalizeText(formatter({ weekday: "short" }));
  const day = formatter({ day: "numeric" });
  const dayPadded = day.padStart(2, "0");
  const monthNumeric = formatter({ month: "numeric" });
  const monthPadded = monthNumeric.padStart(2, "0");
  const year = formatter({ year: "numeric" });

  return new Set(
    [
      `${monthLong} ${day}`,
      `${monthLong} ${day} ${year}`,
      `${monthShort} ${day}`,
      `${monthShort} ${day} ${year}`,
      `${weekdayLong} ${monthLong} ${day}`,
      `${weekdayShort} ${monthShort} ${day}`,
      `${monthNumeric}/${day}`,
      `${monthNumeric}/${dayPadded}`,
      `${monthPadded}/${day}`,
      `${monthPadded}/${dayPadded}`,
      `${year}-${monthPadded}-${dayPadded}`,
      weekdayLong,
      weekdayShort,
    ].map((term) => normalizeText(term)),
  );
}

export async function extractCalendarPlanWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  timeZone = resolveDefaultTimeZone(),
): Promise<CalendarLlmPlan> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const localNow = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  // Derive "today/tomorrow/yesterday" explicitly in the user's timezone so the
  // LLM does not have to do date arithmetic across the UTC/local boundary.
  // Without this anchor we have observed the planner shift "tomorrow" by one
  // day whenever local-midnight crosses the UTC day line.
  const localDateParts = getZonedDateParts(now, timeZone);
  const todayLocal = addDaysToLocalDate(
    {
      year: localDateParts.year,
      month: localDateParts.month,
      day: localDateParts.day,
    },
    0,
  );
  const tomorrowLocal = addDaysToLocalDate(
    {
      year: localDateParts.year,
      month: localDateParts.month,
      day: localDateParts.day,
    },
    1,
  );
  const yesterdayLocal = addDaysToLocalDate(
    {
      year: localDateParts.year,
      month: localDateParts.month,
      day: localDateParts.day,
    },
    -1,
  );
  const formatLocalDate = (parts: {
    year: number;
    month: number;
    day: number;
  }) =>
    `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const localDateAnchors = [
    `yesterday = ${formatLocalDate(yesterdayLocal)}`,
    `today = ${formatLocalDate(todayLocal)}`,
    `tomorrow = ${formatLocalDate(tomorrowLocal)}`,
  ].join(", ");
  const prompt = [
    "Plan the calendar action for this request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "If the current request is vague or a follow-up, recover the subject from recent conversation and apply the new constraint from the current request.",
    "You are allowed to decide that the assistant should reply naturally without acting yet.",
    "Set shouldAct=false when the user is vague, only acknowledging, brainstorming, or asking for calendar help without enough specifics to safely act.",
    "When shouldAct=false, provide a short natural response that asks only for what is missing.",
    "",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-op",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false, otherwise empty or null",
    "  queries: array or ||-delimited string of up to 3 search queries",
    "  title: optional event title",
    "  tripLocation: optional trip location",
    "  timeMin: optional ISO 8601 datetime",
    "  timeMax: optional ISO 8601 datetime",
    "  windowLabel: optional natural-language window label",
    "",
    "subactions[7]{name,use}:",
    "  feed,View schedule for today tomorrow or this week",
    "  next_event,Check the next upcoming event only",
    "  search_events,Find events by title attendee location or date range",
    "  create_event,Schedule a new event",
    "  update_event,Rename reschedule move or edit an existing event",
    "  delete_event,Remove or cancel an existing event",
    "  trip_window,Query what is happening during a trip or stay in a place",
    "Use only the exact subaction literals listed above.",
    "Do not invent aliases like edit_event, modify_event, reschedule_event, move_event, cancel_event, remove_event, agenda, or itinerary_window.",
    "If the user asks to put, add, book, schedule, or enter a new meeting, appointment, call, lunch, or block on the calendar at a stated time, prefer create_event over search_events.",
    "When the user supplies timing for a new calendar item, that is usually create_event even if the subject could also be searched later.",
    "",
    "For feed, search_events, trip_window, update_event, or delete_event, infer an exact timeMin/timeMax window when the request names or implies a date or date range.",
    "For search_events specifically: only set timeMin/timeMax when the user's literal words name a date, day, week, or month. Leave them null for timeless queries like 'find my flight' or 'meetings with Sarah' so the search does not silently narrow away the target event.",
    "timeMin and timeMax must be ISO 8601 datetimes that the API can use directly.",
    "windowLabel should be a short natural-language label like on monday, this weekend, next month, or tonight.",
    "For search_events, update_event, delete_event, or trip_window, extract up to 3 short search queries.",
    "When the user asks whether they have a flight to a place, include the place name as a search query in addition to any flight phrase.",
    "Preserve names, places, and keywords in their original language or script when useful.",
    "Convert time constraints into concise searchable dates or windows even if the user phrases them in another language.",
    "Focus on people, places, flights, itinerary, appointments, and explicit dates.",
    "If the request is about a date, include a date query like april 12 or 2026-04-12.",
    "If the request asks what is happening while the user is in a place, use trip_window and include tripLocation.",
    "For update_event or delete_event, use queries to identify the existing target event and title for the new title only when the user is renaming it.",
    "For requests like all events, full schedule, everything on my calendar, or a broad itinerary sweep, return a broad timeMin/timeMax window instead of relying on downstream heuristics.",
    "",
    'Example feed: {"subaction":"feed","shouldAct":true,"response":null,"queries":[],"title":null,"tripLocation":null,"timeMin":null,"timeMax":null,"windowLabel":"tomorrow"}',
    'Example search: {"subaction":"search_events","shouldAct":true,"response":null,"queries":["flight to denver","denver"],"title":null,"tripLocation":null,"timeMin":null,"timeMax":null,"windowLabel":null}',
    'Example update: {"subaction":"update_event","shouldAct":true,"response":null,"queries":["meeting"],"title":"standup","tripLocation":null,"timeMin":null,"timeMax":null,"windowLabel":null}',
    'Example clarify: {"subaction":null,"shouldAct":false,"response":"What do you want to do on your calendar?","queries":[],"title":null,"tripLocation":null,"timeMin":null,"timeMax":null,"windowLabel":null}',
    "",
    "The user may speak any language. Detect the calendar intent regardless of language.",
    "When the user asks about what is happening in a specific location or during a trip, detect this as trip_window and extract the location, regardless of language.",
    "",
    "Return JSON only as a single object. No prose. No markdown. No hidden reasoning.",
    "",
    `Current timezone: ${timeZone}`,
    `LOCAL DATE ANCHORS (authoritative — IGNORE UTC day for date arithmetic): ${localDateAnchors}.`,
    `Current local datetime: ${localNow}`,
    `Current ISO datetime (informational only — do NOT use for 'today/tomorrow/yesterday'): ${nowIso}`,
    "When the user says 'today', 'tomorrow', 'yesterday', or similar, resolve the calendar day from the LOCAL DATE ANCHORS above (not from the UTC datetime) and build timeMin/timeMax as a full local-day window in the current timezone.",
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  const parseResponse = (raw: string): CalendarLlmPlan | null => {
    const parsed = parseLifeOpsJsonRecord<Record<string, unknown>>(raw);
    return parsed ? buildCalendarPlanFromParsed(parsed) : null;
  };

  const plannerResult = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.plan",
    failureMessage: "Calendar action planning model call failed",
    source: "action:calendar",
  });
  if (!plannerResult) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  const parsedPlan = plannerResult.parsed
    ? buildCalendarPlanFromParsed(plannerResult.parsed)
    : null;
  if (parsedPlan) {
    return finalizeCalendarPlan({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      plan: parsedPlan,
    });
  }

  const repairResult = await runLifeOpsTextModel({
    runtime,
    prompt: buildCalendarPlanRepairPrompt({
      currentMessage,
      intent,
      recentConversation,
      rawResponse: plannerResult.rawResponse,
      timeZone,
      nowIso,
      localNow,
    }),
    actionType: "lifeops.calendar.plan_repair",
    failureMessage: "Calendar action repair model call failed",
    source: "action:calendar",
  });
  if (repairResult === null) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }
  return finalizeCalendarPlan({
    runtime,
    currentMessage,
    intent,
    recentConversation,
    plan: parseResponse(repairResult),
  });
}

function resolveCalendarSearchQueries(args: {
  explicitQueries: Array<string | undefined>;
  llmPlan?: CalendarLlmPlan;
  fallbackQueries?: Array<string | undefined>;
}): string[] {
  return dedupeCalendarQueries([
    ...args.explicitQueries,
    ...(args.llmPlan?.queries ?? []),
    ...(args.fallbackQueries ?? []),
  ]);
}

async function inferCalendarSearchQueriesWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  llmPlan?: CalendarLlmPlan;
}): Promise<string[]> {
  const currentMessage = messageText(args.message).trim();
  const recentConversation = formatCreateEventRecentConversation(args.state);
  const prompt = [
    "Extract up to 3 short calendar search queries for a calendar lookup request.",
    "The user may speak in any language.",
    "Return JSON only as a single object with exactly this field:",
    "  queries: array of up to 3 short strings",
    "Prefer noun phrases and exact dates that would help match calendar event titles, descriptions, locations, attendees, or travel itineraries.",
    "When the request is about a flight or travel itinerary, include the travel phrase and destination if present.",
    "When the request asks what event is on a specific date, include the date itself as a query, for example april 19 or 2026-04-19.",
    "If nothing usable can be extracted, return an empty array.",
    "",
    'Example: {"queries":["flight to denver","denver"]}',
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Current planner output:\n${formatCalendarPromptValue(args.llmPlan ?? null)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.extract_search_queries",
    failureMessage: "Calendar search-query extraction model call failed",
    source: "action:calendar",
  });
  const parsed = result?.parsed;
  if (!parsed) {
    return [];
  }

  const rawQueries: string[] = [];
  if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") {
        rawQueries.push(value);
      }
    }
  } else if (
    typeof parsed.queries === "string" &&
    parsed.queries.trim().length > 0
  ) {
    rawQueries.push(...parsed.queries.split(/\s{0,256}\|\|\s{0,256}/));
  }

  return dedupeCalendarQueries(rawQueries);
}

function normalizeIsShortPreparationFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

function resolveCreateEventDurationMinutes(args: {
  explicitDuration: number | undefined;
  extractedDuration: number | undefined;
  isShortPreparation: boolean;
  hasExplicitEndAt: boolean;
  hasExplicitWindowPreset: boolean;
  hasExplicitStartAt: boolean;
}): number | undefined {
  const {
    explicitDuration,
    extractedDuration,
    isShortPreparation,
    hasExplicitEndAt,
    hasExplicitWindowPreset,
    hasExplicitStartAt,
  } = args;

  if (
    typeof explicitDuration === "number" &&
    Number.isFinite(explicitDuration)
  ) {
    return explicitDuration > 0 ? explicitDuration : undefined;
  }
  if (
    typeof extractedDuration === "number" &&
    Number.isFinite(extractedDuration)
  ) {
    if (extractedDuration > 0) {
      return extractedDuration;
    }
    if (isShortPreparation && (hasExplicitStartAt || hasExplicitWindowPreset)) {
      return MIN_CREATE_EVENT_DURATION_MINUTES;
    }
    return undefined;
  }
  if (
    !hasExplicitEndAt &&
    isShortPreparation &&
    (hasExplicitStartAt || hasExplicitWindowPreset)
  ) {
    return MIN_CREATE_EVENT_DURATION_MINUTES;
  }
  return undefined;
}

type CreateEventRequestBuildArgs = {
  details: Record<string, unknown> | undefined;
  extractedDetails: Record<string, unknown>;
  explicitTitle: string | undefined;
  inferredTitle: string | undefined;
  intent: string;
  fallbackRequest?: CreateLifeOpsCalendarEventRequest;
  preferExtractedDetails?: boolean;
};

type CreateEventRequestBuildResult = {
  title: string | undefined;
  resolvedStartAt: string | undefined;
  resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  request: CreateLifeOpsCalendarEventRequest;
  travelIntent: CreateEventTravelIntent | null;
};

function parseCreateEventDurationValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickCreateEventStringField(
  args: CreateEventRequestBuildArgs,
  key: string,
): string | undefined {
  const explicit = detailString(args.details, key);
  const extracted = detailString(args.extractedDetails, key);
  const fallback =
    args.fallbackRequest &&
    typeof args.fallbackRequest[
      key as keyof CreateLifeOpsCalendarEventRequest
    ] === "string"
      ? (args.fallbackRequest[
          key as keyof CreateLifeOpsCalendarEventRequest
        ] as string)
      : undefined;
  return args.preferExtractedDetails
    ? (extracted ?? explicit ?? fallback)
    : (explicit ?? extracted ?? fallback);
}

function buildCreateEventRequest(
  args: CreateEventRequestBuildArgs,
): CreateEventRequestBuildResult {
  const extractedTitle = detailString(args.extractedDetails, "title");
  const title = args.preferExtractedDetails
    ? (extractedTitle ??
      args.explicitTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle)
    : (args.explicitTitle ??
      extractedTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle);

  const explicitStartAt = detailString(args.details, "startAt");
  const explicitEndAt = detailString(args.details, "endAt");
  const explicitWindowPreset = detailString(args.details, "windowPreset") as
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  const extractedStartAt = detailString(args.extractedDetails, "startAt");
  const extractedEndAt = detailString(args.extractedDetails, "endAt");
  const extractedWindowPreset = detailString(
    args.extractedDetails,
    "windowPreset",
  ) as
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;

  let resolvedStartAt: string | undefined;
  let resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  if (args.preferExtractedDetails && extractedStartAt) {
    resolvedStartAt = extractedStartAt;
    resolvedWindowPreset = undefined;
  } else if (args.preferExtractedDetails && extractedWindowPreset) {
    resolvedStartAt = undefined;
    resolvedWindowPreset = extractedWindowPreset;
  } else {
    resolvedStartAt =
      explicitStartAt ?? extractedStartAt ?? args.fallbackRequest?.startAt;
    resolvedWindowPreset = resolvedStartAt
      ? undefined
      : (explicitWindowPreset ??
        extractedWindowPreset ??
        args.fallbackRequest?.windowPreset);
  }

  const rawEndAt =
    args.preferExtractedDetails &&
    (extractedStartAt || extractedWindowPreset) &&
    !extractedEndAt
      ? undefined
      : args.preferExtractedDetails
        ? (extractedEndAt ?? explicitEndAt ?? args.fallbackRequest?.endAt)
        : (explicitEndAt ?? extractedEndAt ?? args.fallbackRequest?.endAt);

  const explicitDuration = detailNumber(args.details, "durationMinutes");
  const extractedDuration = parseCreateEventDurationValue(
    args.extractedDetails.durationMinutes,
  );
  const fallbackDuration = args.fallbackRequest?.durationMinutes;

  const durationMinutes = resolveCreateEventDurationMinutes({
    explicitDuration: explicitDuration,
    extractedDuration,
    isShortPreparation: normalizeIsShortPreparationFlag(
      args.extractedDetails.isShortPreparation,
    ),
    hasExplicitEndAt: Boolean(rawEndAt),
    hasExplicitWindowPreset: Boolean(resolvedWindowPreset),
    hasExplicitStartAt: Boolean(resolvedStartAt),
  });
  const resolvedDurationMinutes =
    explicitDuration !== undefined || extractedDuration !== undefined
      ? durationMinutes
      : fallbackDuration;
  const travelIntent = resolveCreateEventTravelIntent({
    details: args.details,
    extractedDetails: args.extractedDetails,
  });

  return {
    title,
    resolvedStartAt,
    resolvedWindowPreset,
    travelIntent,
    request: {
      mode:
        (detailString(args.details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined) ?? args.fallbackRequest?.mode,
      side: ((detailString(args.details, "side") as
        | "owner"
        | "agent"
        | undefined) ?? args.fallbackRequest?.side) as
        | "owner"
        | "agent"
        | undefined,
      grantId: detailString(args.details, "grantId"),
      calendarId:
        detailString(args.details, "calendarId") ??
        args.fallbackRequest?.calendarId,
      title: title ?? "",
      description:
        pickCreateEventStringField(args, "description") ??
        args.fallbackRequest?.description,
      location:
        pickCreateEventStringField(args, "location") ??
        args.fallbackRequest?.location,
      startAt: resolvedStartAt,
      endAt: rawEndAt ?? args.fallbackRequest?.endAt,
      timeZone:
        pickCreateEventStringField(args, "timeZone") ??
        args.fallbackRequest?.timeZone,
      durationMinutes: resolvedDurationMinutes,
      windowPreset: resolvedWindowPreset,
      attendees:
        normalizeCalendarAttendees(args.details) ??
        args.fallbackRequest?.attendees,
    },
  };
}

function createEventRequestFingerprint(
  request: CreateLifeOpsCalendarEventRequest,
): string {
  return JSON.stringify({
    title: request.title,
    description: request.description ?? null,
    location: request.location ?? null,
    startAt: request.startAt ?? null,
    endAt: request.endAt ?? null,
    timeZone: request.timeZone ?? null,
    durationMinutes: request.durationMinutes ?? null,
    windowPreset: request.windowPreset ?? null,
    calendarId: request.calendarId ?? null,
    side: request.side ?? null,
    mode: request.mode ?? null,
    grantId: (request as unknown as Record<string, unknown>).grantId ?? null,
  });
}

function formatCreateEventRecentConversation(state: State | undefined): string {
  const conversation = planningConversationLines(state).join("\n").trim();
  return conversation.length > 0 ? conversation : "(none)";
}

function formatUpdateEventTargetContext(
  event: LifeOpsCalendarEvent | null,
): string {
  if (!event) {
    return "(unknown)";
  }
  const attendees = event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  return [
    `title: ${event.title}`,
    `startAt: ${event.startAt}`,
    `endAt: ${event.endAt}`,
    `timeZone: ${event.timezone ?? ""}`,
    `formattedStart: ${formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    })}`,
    `location: ${event.location ?? ""}`,
    `description: ${event.description ?? ""}`,
    `attendees: ${attendees}`,
  ].join("\n");
}

function shouldRetryCreateEventExtraction(error: LifeOpsServiceError): boolean {
  const normalized = normalizeText(error.message);
  if (error.status === 401 || error.status === 403) {
    return false;
  }
  if (
    /\b(?:not connected|needs re-authentication|unauthorized|forbidden|permission|scope|grant)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    error.status === 400 ||
    error.status === 409 ||
    /\b(?:startat|endat|duration|windowpreset|date|time|timezone|datetime|later than|invalid|bad request|parse|format)\b/.test(
      normalized,
    )
  );
}

async function inferCreateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  calendarContext: CreateEventCalendarContext | null,
  fallbackTimeZone = resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  // Anchor the LLM in the present so relative phrases ("tomorrow", "next
  // friday", "april 15") and explicit-but-yearless dates resolve to the
  // correct ISO datetime instead of guessing or returning empty.
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const calendarTimeZone =
    calendarContext?.calendarTimeZone ?? fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event creation fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "Treat the latest user request as authoritative, but recover missing event subject, date, or location from earlier turns when needed.",
    "If the current request is a follow-up, recover the event subject from recent conversation and apply new timing or location constraints from the current request.",
    "Use the calendar context below to ground any timing guess.",
    "Preserve names and places in their original language or script when useful.",
    "Return JSON only as a single object. No prose. Leave fields empty when unknown.",
    "If a start time or window is implied but duration is not explicit, infer a reasonable positive duration.",
    "For short prep or reminder blocks, use at least 15 minutes instead of 0.",
    "Set isShortPreparation=true when the event is a brief prep/reminder/leave-for/get-ready block (any language) where 15 minutes is the right default.",
    "When the user gives a concrete day or date without an exact time-of-day, use the calendar context to infer a plausible open startAt in the calendar timezone. Avoid obvious overlaps with nearby events. If the calendar context is unavailable or the timing is ambiguous, leave startAt empty.",
    "Only use windowPreset for explicit 'tomorrow morning|afternoon|evening' phrasing — never as a fallback for arbitrary dates.",
    "If the user asks for travel time, commute time, or a buffer from a place, capture the origin separately as travelOriginAddress.",
    "Leave travelOriginAddress empty unless the request explicitly names the origin or departure place.",
    "",
    "title: event title",
    "description: optional description",
    "location: optional location",
    "startAt: ISO datetime if explicit or resolvable from a date phrase",
    "endAt: ISO datetime if explicit",
    "durationMinutes: number if implied",
    "windowPreset: tomorrow_morning|tomorrow_afternoon|tomorrow_evening",
    "timeZone: IANA timezone if stated",
    "travelOriginAddress: optional origin address for travel-time calculation",
    "isShortPreparation: true|false",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Calendar context:\n${formatCreateEventCalendarContext(calendarContext)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.extract_create_event",
    failureMessage: "Calendar create-event extraction model call failed",
    source: "action:calendar",
  });
  return result?.parsed ?? {};
}

async function inferUpdateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  targetEvent: LifeOpsCalendarEvent | null,
  fallbackTimeZone = targetEvent?.timezone ?? resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event update fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "The current event below is the source of truth for unchanged fields.",
    "Only return fields the user is actually changing. Leave fields empty when unchanged or unknown.",
    "If the user asks to move or reschedule the event, compute absolute ISO datetimes for the updated startAt and endAt using the current event as context.",
    "If the user gives a relative shift like later, earlier, push back, or move forward, apply it to the current event timing.",
    "Unless the user explicitly changes the timezone, preserve the current event timezone.",
    "If the user only renames the event, leave startAt, endAt, location, description, and timeZone empty.",
    "Return JSON only as a single object. No prose.",
    "",
    "title: new event title if changed",
    "description: updated description if changed",
    "location: updated location if changed",
    "startAt: updated ISO datetime if changed",
    "endAt: updated ISO datetime if changed",
    "timeZone: IANA timezone if changed or needed to interpret the update",
    "",
    `Current timezone: ${timeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Current event:\n${formatUpdateEventTargetContext(targetEvent)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.extract_update_event",
    failureMessage: "Calendar update-event extraction model call failed",
    source: "action:calendar",
  });
  return result?.parsed ?? {};
}

async function repairCreateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  calendarContext: CreateEventCalendarContext | null,
  failedRequest: CreateLifeOpsCalendarEventRequest,
  previousExtraction: Record<string, unknown>,
  error: LifeOpsServiceError,
  fallbackTimeZone = resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const timeZone = fallbackTimeZone;
  const calendarTimeZone =
    calendarContext?.calendarTimeZone ?? fallbackTimeZone;
  const nowIso = now.toISOString();
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event creation fields from the request.",
    "The previous create attempt failed. Repair the extraction so the next create attempt succeeds.",
    "Use the full recent conversation below, not just the latest message.",
    "The latest user request is authoritative, but preserve the existing event subject, people, and places unless the user changed them.",
    "Use the calendar context below to ground any timing repair.",
    "Use the exact failure reason to correct only the broken fields.",
    "If the request includes travel time or commute language, preserve travelOriginAddress when it was recoverable.",
    "Return JSON only as a single object. No prose. Leave fields empty when unchanged or unknown.",
    "",
    "title: event title",
    "description: optional description",
    "location: optional location",
    "startAt: ISO datetime if explicit or resolvable from a date phrase",
    "endAt: ISO datetime if explicit",
    "durationMinutes: number if implied",
    "windowPreset: tomorrow_morning|tomorrow_afternoon|tomorrow_evening",
    "timeZone: IANA timezone if stated",
    "travelOriginAddress: optional origin address for travel-time calculation",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    `Create failure: ${error.message}`,
    `Previous extraction:\n${formatCalendarPromptValue(previousExtraction)}`,
    `Previous create request:\n${formatCalendarPromptValue(failedRequest)}`,
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Calendar context:\n${formatCreateEventCalendarContext(calendarContext)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.repair_create_event",
    failureMessage: "Calendar create-event repair model call failed",
    source: "action:calendar",
  });
  return result?.parsed ?? {};
}

function scoreCalendarEvent(
  event: LifeOpsCalendarEvent,
  query: string,
): number {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(event.title);
  const description = normalizeText(event.description);
  const location = normalizeText(event.location);
  const attendees = event.attendees
    .flatMap((attendee) => [attendee.displayName ?? "", attendee.email ?? ""])
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
  let score = 0;

  const queryVariants = [
    ...new Set([normalizedQuery, ...tokenVariants(normalizedQuery)]),
  ];
  if (queryVariants.some((variant) => title === variant)) {
    score += 100;
  } else if (
    queryVariants.some(
      (variant) => variant.length > 0 && title.includes(variant),
    )
  ) {
    score += 75;
  }

  if (
    queryVariants.some(
      (variant) => variant.length > 0 && description.includes(variant),
    )
  ) {
    score += 35;
  }
  if (
    queryVariants.some(
      (variant) => variant.length > 0 && location.includes(variant),
    )
  ) {
    score += 30;
  }
  if (
    attendees.some((value) =>
      queryVariants.some(
        (variant) => variant.length > 0 && value.includes(variant),
      ),
    )
  ) {
    score += 25;
  }

  const queryTokens = tokenizeForSearch(normalizedQuery);
  if (queryTokens.length > 0) {
    const titleTokens = new Set(tokenizeForSearch(title));
    const descriptionTokens = new Set(tokenizeForSearch(description));
    const locationTokens = new Set(tokenizeForSearch(location));
    const attendeeTokens = attendees.flatMap((value) =>
      tokenizeForSearch(value),
    );
    const attendeeTokenSet = new Set(attendeeTokens);

    score += queryTokens.filter((token) => titleTokens.has(token)).length * 12;
    score +=
      queryTokens.filter((token) => descriptionTokens.has(token)).length * 8;
    score +=
      queryTokens.filter((token) => locationTokens.has(token)).length * 14;
    score +=
      queryTokens.filter((token) => attendeeTokenSet.has(token)).length * 8;
  }

  // (Earlier revisions added an English-only "return/back/home" boost and a
  // counter-penalty against generic flight/travel/trip events. Token matching
  // above already covers any language; the boost was multilingual-hostile and
  // produced wrong results when the user said the equivalent in another
  // language. The grounded LLM disambiguation step picks the right match
  // when token scores are tied.)

  const dateTerms = eventDateSearchTerms(event);
  if (
    [...dateTerms].some(
      (term) =>
        term === normalizedQuery ||
        normalizedQuery.includes(term) ||
        term.includes(normalizedQuery),
    )
  ) {
    score += 90;
  }
  const dateTokens = new Set(
    [...dateTerms].flatMap((term) => tokenizeForSearch(term)),
  );
  score += queryTokens.filter((token) => dateTokens.has(token)).length * 10;

  return score;
}

function shouldGroundCalendarSearchWithLlm(
  query: string,
  rankedEvents: RankedCalendarSearchCandidate[],
): boolean {
  const strongestScore = rankedEvents[0]?.score ?? 0;
  if (strongestScore <= 0) {
    return false;
  }
  if (strongestScore >= 72) {
    return false;
  }
  return wordCount(query) >= 2 || rankedEvents.length > 1;
}

function normalizeCalendarMatchIdsFromValue(
  value: unknown,
  allowedIds: Set<string>,
): string[] {
  const rawIds: string[] = [];
  if (typeof value === "string") {
    for (const token of value.split(
      /\s{0,256}\|\|\s{0,256}|\s{0,256},\s{0,256}|\s{1,256}/,
    )) {
      if (token.trim().length > 0) {
        rawIds.push(token.trim());
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        rawIds.push(item.trim());
      }
    }
  }
  return [...new Set(rawIds.filter((id) => allowedIds.has(id)))];
}

function extractCalendarGroundedMatchIds(
  rawResponse: string,
  allowedIds: Set<string>,
): string[] | null {
  const parsed = parseLifeOpsJsonRecord<Record<string, unknown>>(rawResponse);
  if (!parsed) {
    return null;
  }

  const possibleKeys = [
    "matchIds",
    "matches",
    "ids",
    "matchId",
    "matchId1",
    "matchId2",
    "matchId3",
  ] as const;
  const sawExplicitMatchField = possibleKeys.some((key) => key in parsed);
  if (!sawExplicitMatchField) {
    return null;
  }

  const ids = possibleKeys.flatMap((key) =>
    normalizeCalendarMatchIdsFromValue(parsed[key], allowedIds),
  );
  return [...new Set(ids)];
}

function formatCalendarCandidateForGrounding(
  candidate: RankedCalendarSearchCandidate,
): string {
  const attendees = candidate.event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  return [
    `id: ${candidate.event.id}`,
    `score: ${candidate.score}`,
    `title: ${candidate.event.title}`,
    `startAt: ${candidate.event.startAt}`,
    `location: ${candidate.event.location ?? ""}`,
    `description: ${(candidate.event.description ?? "").slice(0, 240)}`,
    `attendees: ${attendees}`,
  ].join("\n");
}

async function groundCalendarSearchMatchesWithLlm(
  runtime: IAgentRuntime,
  state: State | undefined,
  intent: string,
  queries: string[],
  candidates: RankedCalendarSearchCandidate[],
): Promise<string[] | null> {
  if (candidates.length === 0) {
    return [];
  }

  const recentConversation = formatCreateEventRecentConversation(state);
  const allowedIds = new Set(candidates.map((candidate) => candidate.event.id));
  const prompt = [
    "Decide which candidate calendar events directly match the user's request.",
    "Be strict.",
    "Return NO matches when the candidate only shares a generic time window or vague travel context.",
    "If the request names a person, company, topic, or event name, only match candidates that explicitly mention that subject in the title, description, location, or attendees.",
    "Flights only count when the request is actually about flights/travel, or the flight text explicitly mentions the named subject.",
    "Return JSON only as a single object. No prose. No hidden reasoning.",
    "Return matchIds as an array of ids.",
    "",
    'Example: {"matchIds":["evt_1","evt_2"],"reason":""}',
    "",
    `Resolved intent:\n${intent}`,
    `Search queries:\n${queries.join(" || ")}`,
    `Recent conversation:\n${recentConversation}`,
    "",
    "Candidates:",
    ...candidates.map(
      (candidate, index) =>
        `candidate ${index + 1}\n${formatCalendarCandidateForGrounding(candidate)}`,
    ),
  ].join("\n");

  const rawResponse = await runLifeOpsTextModel({
    runtime,
    prompt,
    actionType: "lifeops.calendar.ground_search_matches",
    failureMessage: "Calendar search grounding model call failed",
    source: "action:calendar",
  });
  return rawResponse === null
    ? null
    : extractCalendarGroundedMatchIds(rawResponse, allowedIds);
}

function buildCalendarGroundingCandidates(
  events: LifeOpsCalendarEvent[],
): RankedCalendarSearchCandidate[] {
  return events.slice(0, 24).map((event, index) => ({
    event,
    score: Math.max(1, 24 - index),
    matchedQueries: [],
  }));
}

function eventStartMs(event: LifeOpsCalendarEvent): number {
  return Date.parse(event.startAt);
}

function eventEndMs(event: LifeOpsCalendarEvent): number {
  const parsed = Date.parse(event.endAt);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return eventStartMs(event);
}

function resolveTripWindowEvents(
  events: LifeOpsCalendarEvent[],
  location: string,
): LifeOpsCalendarEvent[] | null {
  // Trip-window anchoring is driven entirely by location-token matching via
  // scoreCalendarEvent. The previous English-only "travel keyword" boost
  // (flight/hotel/airbnb/...) was multilingual-hostile; the LLM trip_window
  // planner already supplies a location, so location matching alone is enough.
  const anchors = events
    .map((event) => ({
      event,
      score: scoreCalendarEvent(event, location),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) => eventStartMs(left.event) - eventStartMs(right.event),
    );

  if (anchors.length === 0) {
    return null;
  }

  const windowStart = Math.min(
    ...anchors.map((candidate) => eventStartMs(candidate.event)),
  );
  const windowEnd = Math.max(
    ...anchors.map((candidate) => eventEndMs(candidate.event)),
  );

  return events
    .filter(
      (event) =>
        eventEndMs(event) >= windowStart && eventStartMs(event) <= windowEnd,
    )
    .sort((left, right) => eventStartMs(left) - eventStartMs(right));
}

function formatCalendarMoment(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      month: "short",
      day: "numeric",
    }).format(new Date(event.startAt));
  }
  return formatCalendarEventDateTime(event);
}

function formatTripWindowResults(
  events: LifeOpsCalendarEvent[],
  location: string,
): string {
  if (events.length === 0) {
    return `I couldn't find any upcoming calendar events while you're in ${location}.`;
  }

  const lines = [`Here's what's on your calendar while you're in ${location}:`];
  for (const event of events.slice(0, 12)) {
    lines.push(`- ${formatCalendarMoment(event)}: **${event.title}**`);
  }
  return lines.join("\n");
}

function formatCalendarSearchResults(
  events: LifeOpsCalendarEvent[],
  query: string,
  label: string,
): string {
  if (events.length === 0) {
    return `No calendar events matched "${query}" ${label}.`;
  }
  if (events.length === 1) {
    const event = events.at(0);
    if (!event) {
      return `No calendar events matched "${query}" ${label}.`;
    }
    // The fallback wording is intentionally generic ("calendar event") so it
    // is correct in any language. The grounded LLM reply renderer is what
    // gives this string its final natural phrasing — no English keyword
    // regex picks the noun anymore.
    return `Your matching calendar event is **${event.title}** (${formatCalendarMoment(event)}).`;
  }
  const lines = [
    `Found ${events.length} calendar event${events.length === 1 ? "" : "s"} for "${query}" ${label}:`,
  ];
  for (const event of events.slice(0, 8)) {
    const when = event.isAllDay
      ? "all day"
      : formatCalendarEventDateTime(event);
    lines.push(`- **${event.title}** (${when})`);
    if (event.location) {
      lines.push(`  Location: ${event.location}`);
    }
    if (event.description) {
      lines.push(`  ${event.description.slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

function normalizeCalendarAttendees(
  details: Record<string, unknown> | undefined,
): CreateLifeOpsCalendarEventAttendee[] | undefined {
  const attendees = detailArray(details, "attendees");
  if (!attendees) {
    return undefined;
  }
  const mapped: Array<CreateLifeOpsCalendarEventAttendee | null> =
    attendees.map((attendee) => {
      if (typeof attendee === "string" && attendee.trim().length > 0) {
        return {
          email: attendee.trim(),
        };
      }
      if (
        !attendee ||
        typeof attendee !== "object" ||
        Array.isArray(attendee)
      ) {
        return null;
      }
      const record = attendee as Record<string, unknown>;
      const email =
        typeof record.email === "string" && record.email.trim().length > 0
          ? record.email.trim()
          : null;
      if (!email) {
        return null;
      }
      return {
        email,
        displayName:
          typeof record.displayName === "string" &&
          record.displayName.trim().length > 0
            ? record.displayName.trim()
            : undefined,
        optional:
          typeof record.optional === "boolean" ? record.optional : undefined,
      };
    });
  const normalized = mapped.filter(
    (attendee): attendee is CreateLifeOpsCalendarEventAttendee =>
      attendee !== null,
  );
  return normalized.length > 0 ? normalized : undefined;
}

export const calendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "CALENDAR",
  similes: [
    "CALENDAR_ACTION",
    "CHECK_CALENDAR",
    "SHOW_CALENDAR_TODAY",
    "TODAY_SCHEDULE",
    "WEEK_AHEAD",
    "WEEK_VIEW",
    "WHATS_MY_NEXT_MEETING",
    "SCHEDULE_EVENT",
    "CREATE_CALENDAR_EVENT",
    "SEARCH_CALENDAR",
    "NEXT_MEETING",
    "ITINERARY",
    "TRAVEL_SCHEDULE",
    "CHECK_SCHEDULE",
    "BOOK_TIME_BLOCK",
    "RECURRING_TIME_BLOCK",
    "REBOOK_TRAVEL",
  ],
  tags: [
    "always-include",
    "calendar",
    "event",
    "recurring block",
    "time block",
    "travel itinerary",
  ],
  description:
    "Interact with Google Calendar through LifeOps. " +
    "USE this action for: viewing today's or this week's schedule; checking the next upcoming event; " +
    "searching events by title, attendee, location, or date range; creating new calendar events; " +
    "requests like 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', or 'schedule a dentist appointment next Tuesday at 3pm'; " +
    "querying travel itineraries, flights, hotel stays, trip windows, reserving recurring time blocks, and rebooking or moving calendar-backed commitments. " +
    "These are live calendar reads and writes, so do not answer them from provider context alone and do not fall back to NONE or REPLY when this action is available. " +
    "DO NOT use this action when the user is only making an observation like 'my calendar has been crazy this quarter' unless they actually ask you to inspect or change calendar state. " +
    "DO NOT use this action for email inbox work, drafting or sending emails — use MESSAGE with operation=triage, search_inbox, draft_reply, or send_draft (source=gmail for Gmail-specific work) instead. " +
    "DO NOT use this action for personal habits, goals, routines, or reminders — use OWNER_LIFE instead. " +
    "DO NOT use this action to propose or suggest candidate meeting times to send to someone — use OWNER_CALENDAR for requests like 'propose three times for a 30 min sync with X', 'suggest meeting slots', or 'find times that work next week'. The create_event subaction is only for booking a single known time on your own calendar. " +
    "This action provides the final grounded reply; do not pair it with a speculative REPLY action.",
  descriptionCompressed:
    "Google Calendar via LifeOps: view schedule, search events, create events, query travel. Not for email or habits.",
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    return hasLifeOpsAccess(runtime, message);
  },
  handler: async (
    runtime,
    message,
    state,
    options,
    callback?: HandlerCallback,
  ) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text =
        "Calendar actions are restricted to the owner and the agent.";
      await callback?.({ text });
      return {
        success: false,
        text,
      };
    }

    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | CalendarActionParams
      | undefined;
    const params = rawParams ?? ({} as CalendarActionParams);
    const intent = resolveCalendarIntentInput(params.intent, message);

    const details = normalizeCalendarDetails(params.details);
    const planningTimeZone = resolveCalendarTimeZone(details);
    const llmPlan = await extractCalendarPlanWithLlm(
      runtime,
      message,
      state,
      intent,
      planningTimeZone,
    );
    const explicitSubaction = normalizeCalendarSubaction(params.subaction);
    const explicitTitle =
      (typeof params.title === "string" && params.title.trim().length > 0
        ? params.title.trim()
        : undefined) ??
      detailString(details, "title") ??
      llmPlan.title;
    const inferredTitle = explicitTitle ?? llmPlan.title;
    const tripWindowIntent =
      llmPlan.tripLocation && llmPlan.tripLocation.trim().length > 0
        ? { location: llmPlan.tripLocation.trim() }
        : null;
    const structuredSubaction = resolveStructuredCalendarSubaction(
      params,
      details,
    );
    const hasExplicitCalendarExecutionInput = Boolean(
      explicitSubaction ||
        params.title ||
        params.query ||
        (params.queries?.length ?? 0) > 0 ||
        detailString(details, "query") ||
        (detailArray(details, "queries")?.length ?? 0) > 0 ||
        detailString(details, "eventId") ||
        detailString(details, "startAt") ||
        detailString(details, "endAt") ||
        detailString(details, "location") ||
        detailString(details, "windowPreset") ||
        detailNumber(details, "windowDays"),
    );
    const subaction =
      explicitSubaction ??
      llmPlan.subaction ??
      (tripWindowIntent ? "trip_window" : null) ??
      structuredSubaction;
    let searchQueries = resolveCalendarSearchQueries({
      explicitQueries: [
        params.query,
        detailString(details, "query"),
        ...(params.queries ?? []),
        ...(detailArray(details, "queries")?.map((value) =>
          typeof value === "string" ? value : undefined,
        ) ?? []),
      ],
      llmPlan,
      fallbackQueries: [tripWindowIntent?.location],
    });
    if (subaction === "search_events" && searchQueries.length === 0) {
      searchQueries = await inferCalendarSearchQueriesWithLlm({
        runtime,
        message,
        state,
        intent,
        llmPlan,
      });
    }
    const service = new LifeOpsService(runtime);
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      text: string;
      data?: T;
    }) => {
      await callback?.({
        text: payload.text,
        source: "action",
        action: "OWNER_CALENDAR",
      });
      return payload;
    };
    const renderReply = (
      scenario: string,
      fallback: string,
      context?: Record<string, unknown>,
    ) =>
      renderCalendarActionReply({
        runtime,
        message,
        state,
        intent,
        scenario,
        fallback,
        context,
      });

    if (
      llmPlan.shouldAct === false &&
      !hasExplicitCalendarExecutionInput &&
      !explicitSubaction
    ) {
      const fallback =
        llmPlan.response ?? buildCalendarReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    if (!subaction) {
      const fallback =
        llmPlan.response ?? buildCalendarReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    try {
      const google = await getGoogleCapabilityStatus(service);

      if (subaction === "next_event") {
        if (!google.hasCalendarRead) {
          return respond({
            success: false,
            text: calendarReadUnavailableMessage(google),
          });
        }
        const context = await service.getNextCalendarEventContext(
          INTERNAL_URL,
          {
            calendarId: detailString(details, "calendarId"),
            timeZone: resolveCalendarTimeZone(details),
          },
        );
        const fallback = formatNextEventContext(context);
        return respond({
          success: true,
          text: await renderReply("next_event", fallback, {
            event: context,
          }),
          data: toActionData(context),
        });
      }

      if (subaction === "create_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        let calendarContext: CreateEventCalendarContext | null = null;
        try {
          calendarContext = await loadCreateEventCalendarContext(
            service,
            details,
            google.hasCalendarRead,
          );
        } catch (error) {
          runtime.logger?.warn?.(
            {
              src: "action:calendar",
              error: error instanceof Error ? error.message : String(error),
            },
            "Calendar create-event context fetch failed",
          );
        }
        const extractedDetails = await inferCreateEventDetails(
          runtime,
          message,
          state,
          intent,
          calendarContext,
          planningTimeZone,
        );
        const createEventBuild = buildCreateEventRequest({
          details,
          extractedDetails,
          explicitTitle,
          inferredTitle,
          intent,
        });
        const { title, resolvedStartAt, resolvedWindowPreset, request } =
          createEventBuild;
        let travelIntent = createEventBuild.travelIntent;
        const calendarLookup = {
          getCalendarFeed: service.getCalendarFeed.bind(service),
        };
        if (!title) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_create_event_title",
              "What event do you want to add?",
              {
                missing: ["title"],
              },
            ),
          });
        }
        // The LifeOps service throws a raw 400 when neither startAt nor a
        // window preset is supplied. Catch that case here so the user gets a
        // useful prompt instead of "startAt is required when windowPreset is
        // not provided" — and so the failure path doesn't re-trigger the
        // action through planner follow-up.
        if (!resolvedStartAt && !resolvedWindowPreset) {
          const suggestedStartAt = title
            ? suggestCreateEventStartAt({
                currentMessage: messageText(message).trim(),
                intent,
                title,
                calendarContext,
              })
            : null;
          const fallback = suggestedStartAt
            ? `i can tentatively put "${title}" on ${formatCalendarEventDateTime(
                {
                  startAt: suggestedStartAt.startAt,
                  timezone: suggestedStartAt.timeZone,
                },
                { includeTimeZoneName: true },
              )}. if you want a different time, tell me what works better.`
            : `i need a time for "${title}" in ${
                calendarContext?.calendarTimeZone ??
                resolveCalendarTimeZone(details)
              }. try "tomorrow morning", "tomorrow afternoon", "tomorrow evening", or give me a specific date and time.`;
          return respond({
            success: false,
            text: await renderReply("clarify_create_event_time", fallback, {
              title,
              suggestedStartAt,
              calendarTimeZone:
                calendarContext?.calendarTimeZone ??
                resolveCalendarTimeZone(details),
            }),
          });
        }
        let requestToCreate = request;
        let event: LifeOpsCalendarEvent;
        try {
          event = await service.createCalendarEvent(
            INTERNAL_URL,
            requestToCreate,
          );
        } catch (error) {
          if (
            error instanceof LifeOpsServiceError &&
            shouldRetryCreateEventExtraction(error)
          ) {
            const repairedDetails = await repairCreateEventDetails(
              runtime,
              message,
              state,
              intent,
              calendarContext,
              requestToCreate,
              extractedDetails,
              error,
              planningTimeZone,
            );
            const repaired = buildCreateEventRequest({
              details,
              extractedDetails: repairedDetails,
              explicitTitle,
              inferredTitle,
              intent,
              fallbackRequest: requestToCreate,
              preferExtractedDetails: true,
            });
            if (
              repaired.title &&
              (repaired.resolvedStartAt || repaired.resolvedWindowPreset) &&
              createEventRequestFingerprint(repaired.request) !==
                createEventRequestFingerprint(requestToCreate)
            ) {
              runtime.logger?.info?.(
                {
                  src: "action:calendar",
                  error: error.message,
                  priorRequest: requestToCreate,
                  repairedRequest: repaired.request,
                },
                "Retrying calendar create-event after repair extraction",
              );
              requestToCreate = repaired.request;
              travelIntent = repaired.travelIntent ?? travelIntent;
              event = await service.createCalendarEvent(
                INTERNAL_URL,
                requestToCreate,
              );
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
        let travelBuffer: Awaited<
          ReturnType<typeof computeCreateEventTravelBuffer>
        > | null = null;
        let travelTimeUnavailable: TravelTimeUnavailableError | null = null;
        if (travelIntent) {
          try {
            travelBuffer = await computeCreateEventTravelBuffer({
              runtime,
              calendar: calendarLookup,
              event: {
                id: event.id,
                location: event.location ?? "",
              },
              travelIntent,
            });
          } catch (error) {
            if (!(error instanceof TravelTimeUnavailableError)) {
              throw error;
            }
            travelTimeUnavailable = error;
          }
        }
        const travelContext = travelBuffer
          ? {
              travelOriginAddress: travelBuffer.originAddress,
              travelDestinationAddress: travelBuffer.destinationAddress,
              travelBufferMinutes: travelBuffer.bufferMinutes,
              travelBufferMethod: travelBuffer.method,
              travelTime: travelBuffer,
            }
          : null;
        const travelErrorContext = travelTimeUnavailable
          ? {
              travelTimeError: "TRAVEL_TIME_UNAVAILABLE",
              travelTimeErrorCode: travelTimeUnavailable.code,
              travelTimeErrorMessage: travelTimeUnavailable.message,
            }
          : null;
        const fallback = travelBuffer
          ? `Created calendar event "${event.title}" for ${formatCalendarEventDateTime(
              event,
              {
                includeTimeZoneName: true,
              },
            )} with a ${travelBuffer.bufferMinutes}-minute travel buffer.`
          : travelTimeUnavailable
            ? `Created calendar event "${event.title}" for ${formatCalendarEventDateTime(
                event,
                {
                  includeTimeZoneName: true,
                },
              )}. Travel buffer was not added: ${travelTimeUnavailable.message}`
            : `Created calendar event "${event.title}" for ${formatCalendarEventDateTime(
                event,
                {
                  includeTimeZoneName: true,
                },
              )}.`;
        return respond({
          success: true,
          text: await renderReply("created_event", fallback, {
            event,
            request: requestToCreate,
            ...(travelContext ?? {}),
            ...(travelErrorContext ?? {}),
          }),
          data: toActionData({
            ...event,
            ...(travelContext ?? {}),
            ...(travelErrorContext ?? {}),
            request: requestToCreate,
          }),
        });
      }

      if (subaction === "update_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        const explicitEventId = detailString(details, "eventId");
        let resolvedEventId = explicitEventId;
        let resolvedCalendarId = detailString(details, "calendarId");
        let targetEvent: LifeOpsCalendarEvent | null = null;
        if (!resolvedEventId) {
          const titleHint = searchQueries[0];
          if (!titleHint) {
            return respond({
              success: false,
              text: await renderReply(
                "clarify_update_event_target",
                "Tell me which calendar event you want to change by title, person, place, or date.",
                {
                  missing: ["target event"],
                },
              ),
            });
          }
          const feedRequest =
            detailString(details, "timeMin") ||
            detailString(details, "timeMax") ||
            llmPlan.timeMin ||
            llmPlan.timeMax
              ? resolveCalendarWindow(intent, details, true, llmPlan).request
              : {
                  calendarId: detailString(details, "calendarId"),
                  timeZone: resolveCalendarTimeZone(details),
                  ...buildWideLookupRange(resolveCalendarTimeZone(details)),
                };
          const feed = await service.getCalendarFeed(INTERNAL_URL, {
            includeHiddenCalendars: true,
            mode: detailString(details, "mode") as
              | "local"
              | "remote"
              | "cloud_managed"
              | undefined,
            side: detailString(details, "side") as
              | "owner"
              | "agent"
              | undefined,
            grantId: detailString(details, "grantId"),
            forceSync: true,
            ...feedRequest,
          });
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = titleHint
              ? `i couldn't find an event matching "${titleHint}" in that window.`
              : "i couldn't find any events to update in that window. give me a title or a date.";
            return respond({
              success: false,
              text: await renderReply("update_event_not_found", fallback, {
                titleHint,
              }),
            });
          }
          if (candidates.length > 1) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "update",
              candidates,
              titleHint,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_update_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint,
                candidates,
              }),
            });
          }
          targetEvent = candidates.at(0) ?? null;
          if (!targetEvent) {
            return respond({
              success: false,
              text: await renderReply(
                "update_event_not_found",
                "i couldn't find a unique event to update.",
                { titleHint },
              ),
            });
          }
          resolvedEventId = targetEvent.externalId;
          resolvedCalendarId = targetEvent.calendarId;
        }
        const newTitle = detailString(details, "newTitle") ?? explicitTitle;
        const explicitStartAtForUpdate = detailString(details, "startAt");
        const explicitEndAtForUpdate = detailString(details, "endAt");
        const extractedForUpdate = targetEvent
          ? await inferUpdateEventDetails(
              runtime,
              message,
              state,
              intent,
              targetEvent,
              targetEvent?.timezone ?? planningTimeZone,
            )
          : ({} as Record<string, unknown>);
        const extractedStartAt =
          typeof extractedForUpdate.startAt === "string"
            ? extractedForUpdate.startAt.trim()
            : undefined;
        const extractedEndAt =
          typeof extractedForUpdate.endAt === "string"
            ? extractedForUpdate.endAt.trim()
            : undefined;
        const extractedLocation =
          typeof extractedForUpdate.location === "string"
            ? extractedForUpdate.location.trim()
            : undefined;
        const extractedDescription =
          typeof extractedForUpdate.description === "string"
            ? extractedForUpdate.description.trim()
            : undefined;
        const extractedTimeZoneForUpdate =
          typeof extractedForUpdate.timeZone === "string"
            ? extractedForUpdate.timeZone.trim()
            : undefined;

        const event = await service.updateCalendarEvent(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          calendarId: resolvedCalendarId,
          eventId: resolvedEventId ?? "",
          title: newTitle,
          description:
            detailString(details, "description") ?? extractedDescription,
          location: detailString(details, "location") ?? extractedLocation,
          startAt: explicitStartAtForUpdate ?? extractedStartAt,
          endAt: explicitEndAtForUpdate ?? extractedEndAt,
          timeZone:
            detailString(details, "timeZone") ??
            extractedTimeZoneForUpdate ??
            targetEvent?.timezone ??
            undefined,
        });
        const fallback = `updated "${event.title}" — ${formatCalendarEventDateTime(
          event,
          {
            includeTimeZoneName: true,
          },
        )}.`;
        return respond({
          success: true,
          text: await renderReply("updated_event", fallback, {
            event,
            targetEvent,
          }),
          data: toActionData(event),
        });
      }

      if (subaction === "delete_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        const explicitEventId = detailString(details, "eventId");
        const calendarIdForDelete = detailString(details, "calendarId");
        const resolvedEventId = explicitEventId;
        let resolvedEventTitle: string | undefined;
        const resolvedCalendarId = calendarIdForDelete;
        if (!resolvedEventId) {
          const titleHint = searchQueries[0];
          if (!titleHint) {
            return respond({
              success: false,
              text: await renderReply(
                "clarify_delete_event_target",
                "Tell me which calendar event you want to delete by title, person, place, or date.",
                {
                  missing: ["target event"],
                },
              ),
            });
          }
          const feedRequest =
            detailString(details, "timeMin") ||
            detailString(details, "timeMax") ||
            llmPlan.timeMin ||
            llmPlan.timeMax
              ? resolveCalendarWindow(intent, details, true, llmPlan).request
              : {
                  calendarId: detailString(details, "calendarId"),
                  timeZone: resolveCalendarTimeZone(details),
                  ...buildWideLookupRange(resolveCalendarTimeZone(details)),
                };
          const feed = await service.getCalendarFeed(INTERNAL_URL, {
            includeHiddenCalendars: true,
            mode: detailString(details, "mode") as
              | "local"
              | "remote"
              | "cloud_managed"
              | undefined,
            side: detailString(details, "side") as
              | "owner"
              | "agent"
              | undefined,
            grantId: detailString(details, "grantId"),
            forceSync: true,
            ...feedRequest,
          });
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = titleHint
              ? `i couldn't find an event matching "${titleHint}" in that window.`
              : "i couldn't find any events to delete in that window. give me a title or a date.";
            return respond({
              success: false,
              text: await renderReply("delete_event_not_found", fallback, {
                titleHint,
              }),
            });
          }

          if (candidates.length > 1) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "delete",
              candidates,
              titleHint,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_delete_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint,
                candidates,
              }),
            });
          }

          const targets = candidates.slice(0, 1);
          const deleteResults: Array<{
            title: string;
            ok: boolean;
            error?: string;
          }> = [];
          for (const target of targets) {
            try {
              await service.deleteCalendarEvent(INTERNAL_URL, {
                mode: detailString(details, "mode") as
                  | "local"
                  | "remote"
                  | "cloud_managed"
                  | undefined,
                side: detailString(details, "side") as
                  | "owner"
                  | "agent"
                  | undefined,
                grantId: detailString(details, "grantId"),
                calendarId: target.calendarId,
                eventId: target.externalId,
              });
              deleteResults.push({ title: target.title, ok: true });
            } catch (err) {
              deleteResults.push({
                title: target.title,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const okCount = deleteResults.filter((r) => r.ok).length;
          const failCount = deleteResults.length - okCount;
          const publicDeleteResults = deleteResults.map((result) => ({
            title: result.title,
            ok: result.ok,
          }));
          const firstDeleteResult = deleteResults.at(0);
          const summary =
            failCount === 0
              ? targets.length === 1
                ? firstDeleteResult
                  ? `deleted "${firstDeleteResult.title}".`
                  : "deleted that event."
                : `deleted ${okCount} matching events.`
              : okCount === 0
                ? `I couldn't delete those ${deleteResults.length} matching events. Try again in a bit or tell me which one to remove.`
                : `Deleted ${okCount} matching event${okCount === 1 ? "" : "s"}, but ${failCount} failed. Tell me which one to remove if you want me to retry individually.`;
          return respond({
            success: failCount === 0,
            text: await renderReply("deleted_event", summary, {
              deleteResults: publicDeleteResults,
              okCount,
              failCount,
            }),
          });
        }
        // Path: explicit eventId was given, no feed lookup needed
        if (!resolvedEventId) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_delete_event_target",
              "i need an event id or a title + date to delete an event.",
              {
                missing: ["event target"],
              },
            ),
          });
        }
        await service.deleteCalendarEvent(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          calendarId: resolvedCalendarId,
          eventId: resolvedEventId,
        });
        const fallback = resolvedEventTitle
          ? `deleted "${resolvedEventTitle}".`
          : "deleted that calendar event.";
        return respond({
          success: true,
          text: await renderReply("deleted_event", fallback, {
            eventTitle: resolvedEventTitle,
          }),
        });
      }

      if (!google.hasCalendarRead) {
        return respond({
          success: false,
          text: calendarReadUnavailableMessage(google),
        });
      }

      if (subaction === "trip_window" && tripWindowIntent) {
        const feed = await service.getCalendarFeed(INTERNAL_URL, {
          includeHiddenCalendars: true,
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          ...resolveTripWindowRequest(details, llmPlan),
        });
        const itineraryEvents = resolveTripWindowEvents(
          feed.events,
          tripWindowIntent.location,
        );
        if (!itineraryEvents || itineraryEvents.length === 0) {
          const fallback = `I couldn't find a clear trip window for ${tripWindowIntent.location} in your upcoming calendar.`;
          return respond({
            success: true,
            text: await renderReply("trip_window_not_found", fallback, {
              location: tripWindowIntent.location,
            }),
            data: toActionData({
              ...feed,
              location: tripWindowIntent.location,
              events: [],
            }),
          });
        }
        const fallback = formatTripWindowResults(
          itineraryEvents,
          tripWindowIntent.location,
        );
        return respond({
          success: true,
          text: await renderReply("trip_window_results", fallback, {
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
          data: toActionData({
            ...feed,
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
        });
      }

      // When the user explicitly asks for "all events" / "everything" / a
      // multi-year span, broaden the lookup window past the default
      // "today only" feed window. resolveCalendarWindow's default is too
      // narrow for these queries — without this branch, "show all my
      // events" returns "no events today" even when the calendar has
      // dozens of upcoming items. We apply this regardless of whether the
      // chat LLM picked feed or search_events because both subactions go
      const baseResolved = resolveCalendarWindow(
        intent,
        details,
        subaction === "search_events",
        llmPlan,
      );
      const request = baseResolved.request;
      const label = baseResolved.label;
      const hasExplicitWindow = baseResolved.explicitWindow;
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        includeHiddenCalendars: true,
        mode: detailString(details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: detailString(details, "side") as "owner" | "agent" | undefined,
        grantId: detailString(details, "grantId"),
        ...request,
      });

      if (subaction === "search_events") {
        let queriesForSearch = searchQueries;
        const currentMessageText = messageText(message);
        const recentConversation = (
          await collectRecentConversationTexts({
            runtime,
            message,
            state,
            limit: 8,
          })
        ).join("\n");
        if (queriesForSearch.length === 0) {
          queriesForSearch = await inferCalendarSearchQueriesWithLlm({
            runtime,
            message,
            state,
            intent,
          });
          if (queriesForSearch.length === 0) {
            const groundedFromFeed = await groundCalendarSearchMatchesWithLlm(
              runtime,
              state,
              intent,
              [],
              buildCalendarGroundingCandidates(feed.events),
            );
            if (groundedFromFeed && groundedFromFeed.length > 0) {
              const groundedIdSet = new Set(groundedFromFeed);
              const filteredEvents = feed.events.filter((event) =>
                groundedIdSet.has(event.id),
              );
              const fallback = formatCalendarSearchResults(
                filteredEvents,
                currentMessageText || intent || "your request",
                label,
              );
              return respond({
                success: true,
                text: await renderReply("search_results", fallback, {
                  query: currentMessageText || intent,
                  queries: [],
                  events: filteredEvents,
                  label,
                }),
                data: toActionData({
                  ...feed,
                  query: currentMessageText || intent,
                  queries: [],
                  events: filteredEvents,
                }),
              });
            }
            const recoveredReadPlan = await disambiguateCalendarReadPlanWithLlm(
              {
                runtime,
                currentMessage: currentMessageText,
                intent,
                recentConversation,
                candidateSubaction: "search_events",
              },
            );
            if (recoveredReadPlan?.subaction === "feed") {
              const fallback = formatCalendarFeed(feed, label);
              return respond({
                success: true,
                text: await renderReply("feed_results", fallback, {
                  label,
                  events: feed.events,
                }),
                data: toActionData(feed),
              });
            }
          }
        }

        const query = queriesForSearch[0];
        if (!query || queriesForSearch.length === 0) {
          if (hasExplicitWindow) {
            const fallback = formatCalendarFeed(feed, label);
            return respond({
              success: true,
              text: await renderReply("feed_results", fallback, {
                label,
                events: feed.events,
              }),
              data: toActionData(feed),
            });
          }
          return respond({
            success: false,
            text: await renderReply(
              "clarify_calendar_search",
              "I couldn't infer what to look for in your calendar yet. Try naming a person, place, trip, or date.",
              {
                missing: ["search target"],
              },
            ),
          });
        }
        const rankedEvents: RankedCalendarSearchCandidate[] = feed.events
          .map((event) => {
            const matchedQueries: string[] = [];
            let score = 0;
            for (const candidateQuery of queriesForSearch) {
              const queryScore = scoreCalendarEvent(event, candidateQuery);
              if (queryScore > 0) {
                matchedQueries.push(candidateQuery);
                score += queryScore;
              }
            }
            if (matchedQueries.length > 1) {
              score += (matchedQueries.length - 1) * 12;
            }
            return { event, score, matchedQueries };
          })
          .filter(
            (candidate) =>
              candidate.score > 0 && candidate.matchedQueries.length > 0,
          )
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            return (
              Date.parse(left.event.startAt) - Date.parse(right.event.startAt)
            );
          });
        const strongestScore = rankedEvents[0]?.score ?? 0;
        const strongestThreshold =
          strongestScore >= 30 ? Math.max(16, strongestScore - 12) : 1;
        let filteredEvents = rankedEvents
          .filter((candidate) => candidate.score >= strongestThreshold)
          .map((candidate) => candidate.event);
        if (shouldGroundCalendarSearchWithLlm(query, rankedEvents)) {
          const groundedIds = await groundCalendarSearchMatchesWithLlm(
            runtime,
            state,
            intent,
            queriesForSearch,
            rankedEvents.slice(0, 6),
          );
          if (groundedIds) {
            const groundedIdSet = new Set(groundedIds);
            filteredEvents = rankedEvents
              .filter((candidate) => groundedIdSet.has(candidate.event.id))
              .map((candidate) => candidate.event);
          }
        }
        if (filteredEvents.length === 0 && feed.events.length > 0) {
          const groundedIds = await groundCalendarSearchMatchesWithLlm(
            runtime,
            state,
            intent,
            queriesForSearch,
            rankedEvents.length > 0
              ? rankedEvents.slice(0, 12)
              : buildCalendarGroundingCandidates(feed.events),
          );
          if (groundedIds && groundedIds.length > 0) {
            const groundedIdSet = new Set(groundedIds);
            filteredEvents = feed.events.filter((event) =>
              groundedIdSet.has(event.id),
            );
          }
        }
        const fallback = formatCalendarSearchResults(
          filteredEvents,
          query,
          label,
        );
        return respond({
          success: true,
          text: await renderReply("search_results", fallback, {
            query,
            queries: queriesForSearch,
            events: filteredEvents,
            label,
          }),
          data: toActionData({
            ...feed,
            query,
            queries: queriesForSearch,
            events: filteredEvents,
          }),
        });
      }

      const fallback = formatCalendarFeed(feed, label);
      return respond({
        success: true,
        text: await renderReply("feed_results", fallback, {
          label,
          events: feed.events,
        }),
        data: toActionData(feed),
      });
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        const fallback = buildCalendarServiceErrorFallback(error, intent);
        return respond({
          success: false,
          text: await renderReply("service_error", fallback, {
            status: error.status,
            subaction,
          }),
        });
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Calendar operation. Use search_events for flights, itinerary, travel, appointments, or keyword lookup; feed for agenda/schedule reads; next_event for the next upcoming event; create_event only when creating a new event.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "feed",
          "next_event",
          "search_events",
          "create_event",
          "update_event",
          "delete_event",
          "trip_window",
        ],
      },
    },
    {
      name: "intent",
      description:
        'Natural language calendar request, especially schedule or itinerary questions. Examples: "what is on my calendar today", "do i have any flights this week", "when do i fly back from denver", "create a meeting tomorrow at 3pm".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Event title when creating an event. Optional for read/search actions.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Short search phrase for search_events, such as flight, dentist, Denver, or return flight.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional array of search phrases for search_events. The action will combine and dedupe them.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "details",
      description:
        "Optional structured calendar fields such as time bounds, timezone, calendar id, create-event timing, location, and attendees.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my calendar today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Events today:\n- **Team sync** (10:00 AM – 10:30 AM)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What is my next meeting?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Next event: Product review** (2:00 PM – 3:00 PM) — in 45 min",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What does my week look like?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "This week's calendar includes 4 events, starting with a dentist appointment on Tuesday at 3:00 PM.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Create a dentist appointment for tomorrow at 3pm." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "Dentist appointment" for tomorrow at 3:00 PM.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Put a 1:1 with Alex on my calendar Thursday at 10am for 30 minutes.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "1:1 with Alex" for Thursday at 10:00 AM for 30 minutes.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a recurring daily one-hour block with Jill, placed before your sleep window when possible.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Flag the conflict before my flight later and, if needed, help rebook the other thing.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll check the flight against your calendar, flag the conflict, and help move the other commitment if it collides.",
        },
      },
    ],
  ] as ActionExample[][],
};
