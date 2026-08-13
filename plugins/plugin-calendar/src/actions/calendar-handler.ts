/**
 * Factory for the `CALENDAR` assistant action and its LLM-backed handler.
 *
 * `createCalendarActionRunner` wires the host-injected dependencies (the model
 * runner and calendar-service access) and returns the `CALENDAR` action.
 * `extractCalendarPlanWithLlm` turns a natural-language request plus recent
 * conversation into a structured `CalendarLlmPlan` (subaction, time window,
 * search queries), and the handler executes that plan against `CalendarService`
 * — read feed, next event, search, create/update/delete events, trip windows —
 * grounding the reply in real event data. `plugin-lifeops` consumes this as the
 * calendar assistant action.
 */
import { createHash } from "node:crypto";
import type {
  Action,
  ActionExample,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  describeUserReference,
  normalizeEffectReceipt,
  resolveOptimizedPromptForRuntime,
  unwrapUserMessageText,
  userReferenceLogView,
} from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared";
import { isAppleCalendarGrant } from "../apple-calendar.js";
import { CALENDAR_DETAILS_PARAMETER_SCHEMA } from "../calendar-action-schema.js";
import {
  CALENDAR_TIME_ZONE_ALIASES,
  isValidTimeZone,
  resolveDefaultTimeZone,
} from "../internal/constants.js";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  INTERNAL_URL,
  messageText,
  parseCalendarJsonRecord,
  sanitizeCalendarId,
  toActionData,
} from "../internal/detail.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_PROVIDER,
} from "../internal/eliza-calendar.js";
import { CalendarServiceError } from "../internal/errors.js";
import {
  formatCalendarEventDateTime,
  formatCalendarFeed,
  formatNextEventContext,
} from "../internal/format.js";
import { GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX } from "../internal/google-delegates.js";
import {
  describeRecurrence,
  normalizeRecurrenceScope,
  recurrenceLinesFrom,
  recurringEventIdFrom,
} from "../internal/recurrence.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "../internal/time.js";
import { isMicrosoftCalendarGrantId } from "../microsoft/accounts.js";
import { CalendarService } from "../service/CalendarService.js";
import type {
  CalendarActionDeps,
  CalendarModelCallArgs,
  CalendarMutationApprovalResult,
  CalendarTravelBufferResult,
  CalendarTravelIntent,
} from "./deps.js";
import { CALENDAR_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

export { CALENDAR_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

/**
 * Host-supplied dependencies, set once when the calendar action is built via
 * {@link createCalendarActionRunner}. The CALENDAR action is registered exactly
 * once per plugin instance, so a module-level holder is the right seam: it
 * keeps the ~40 internal handler functions from each having to thread a `deps`
 * parameter, without leaking the host (LifeOps) into this package's imports.
 */
let injectedDeps: CalendarActionDeps | null = null;

function deps(): CalendarActionDeps {
  if (!injectedDeps) {
    throw new Error(
      "[calendar] calendar action handler invoked before createCalendarActionRunner() supplied dependencies",
    );
  }
  return injectedDeps;
}

function runLifeOpsTextModel(
  args: CalendarModelCallArgs,
): Promise<string | null> {
  return deps().runTextModel(args);
}

function runLifeOpsJsonModel<
  T extends Record<string, unknown> = Record<string, unknown>,
>(args: CalendarModelCallArgs) {
  return deps().runJsonModel<T>(args);
}

function collectRecentConversationTexts(args: {
  runtime: IAgentRuntime;
  message?: Memory;
  state: State | undefined;
  limit: number;
}): Promise<string[]> {
  return deps().recentConversationTexts(args);
}

/**
 * Resolve the calendar domain service. Mirrors the prior `new LifeOpsService`
 * construction — the 7 calendar methods (`getCalendarFeed`,
 * `getNextCalendarEventContext`, `createCalendarEvent`, `updateCalendarEvent`,
 * `deleteCalendarEvent`, …) are identical on `CalendarService`.
 */
function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service) {
    throw new CalendarServiceError(
      503,
      "Calendar service is not available.",
      "CALENDAR_SERVICE_UNAVAILABLE",
    );
  }
  return service;
}

function requireCalendarMutationGateway() {
  const gateway = deps().mutationGateway;
  if (!gateway) {
    throw new CalendarServiceError(
      503,
      "Calendar changes require owner approval, but the approval gateway is unavailable.",
      "CALENDAR_APPROVAL_GATEWAY_UNAVAILABLE",
    );
  }
  return gateway;
}

function requireCompleteFreshCalendarFeed(
  feed: LifeOpsCalendarFeed,
  operation: "create" | "update" | "delete",
): LifeOpsCalendarFeed {
  if (
    feed.state !== "complete" ||
    feed.sources.some((source) => source.status !== "fresh")
  ) {
    throw new CalendarServiceError(
      503,
      `Calendar ${operation} is blocked because one or more requested calendar sources are incomplete or unavailable.`,
      "CALENDAR_MUTATION_CONTEXT_INCOMPLETE",
    );
  }
  return feed;
}

// Planner-authored `details` records are junk-prone input: the planner fills
// every schema key, and the connector-scope hints (`mode`, `side`, `grantId`)
// have no legitimate planner-visible source unless copied verbatim from a
// provider-rendered grant. CalendarService enum-validates these fields with a
// hard 400 — correct for its HTTP routes, fatal for a chat turn: live
// regression 2026-08-09 had feed reads failing CALENDAR_SERVICE_400 because
// the planner filled `mode:"read"` and `grantId:"primary"`. The action
// boundary therefore accepts only recognizable values and drops the rest, so
// placeholder junk cannot abort the read the user asked for.
function connectorModeDetail(
  details: Record<string, unknown> | undefined,
): "local" | "remote" | "cloud_managed" | undefined {
  const value = detailString(details, "mode");
  return value === "local" || value === "remote" || value === "cloud_managed"
    ? value
    : undefined;
}

function connectorSideDetail(
  details: Record<string, unknown> | undefined,
): "owner" | "agent" | undefined {
  const value = detailString(details, "side");
  return value === "owner" || value === "agent" ? value : undefined;
}

// Mutation lookups must stay unscoped when the planner omits grantId: the
// aggregated feed already includes the built-in Eliza source alongside every
// connected provider, so defaulting the lookup to one grant would hide
// external events (and their busy windows) from update/delete/create flows.
// Only values shaped like a real grant id pass through — junk like "primary"
// or "all" would otherwise scope discovery to a nonexistent grant and turn a
// full-feed read into a fabricated-account provider call.
function connectorGrantIdDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const value = detailString(details, "grantId");
  if (!value) return undefined;
  return isAppleCalendarGrant(value) ||
    isMicrosoftCalendarGrantId(value) ||
    value === ELIZA_CALENDAR_GRANT_ID ||
    value.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? value
    : undefined;
}

// Placeholder filtering lives in sanitizeCalendarId (internal/detail.ts); it
// must guard every path a planner-authored calendarId can travel — both the
// direct details read here and the fallbackRequest carry-over in
// buildCreateEventRequest, which replays an earlier planner request and can
// smuggle the same junk back in.
function calendarIdDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  return sanitizeCalendarId(detailString(details, "calendarId"));
}

type CreateEventTravelIntent = CalendarTravelIntent;

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
  startAt: ["startat", "start_at", "start", "start_time", "starttime"],
  endAt: ["endat", "end_at", "end", "end_time", "endtime"],
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
  oldTitle: ["oldtitle", "old_title"],
  description: ["desc", "summary", "body"],
  location: ["place", "venue"],
  recurrence: [
    "rrule",
    "recurrencerule",
    "recurrence_rule",
    "repeat",
    "repeats",
    "repeatrule",
    "repeat_rule",
  ],
  recurrenceScope: [
    "recurrencescope",
    "recurrence_scope",
    "applyto",
    "apply_to",
    "editscope",
    "edit_scope",
  ],
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

/** Deterministic "just this occurrence" phrasing across mutation requests. */
const RECURRENCE_SCOPE_INSTANCE_PATTERN =
  /\b(?:just|only)\s+(?:this|that)(?:\s+(?:one|time|occurrence|instance|event|meeting|week))?\b|\bthis\s+(?:one|occurrence|instance)\s+only\b|\bsingle\s+occurrence\b/i;

/** Deterministic split-at-occurrence phrasing across mutation requests. */
const RECURRENCE_SCOPE_THIS_AND_FOLLOWING_PATTERN =
  /\b(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting|[a-z0-9_-]+))?\s+(?:and|&)\s+(?:(?:all|every)\s+)?(?:following|future|everything\s+after)(?:\s+(?:events|occurrences|instances|ones))?\b|\bfrom\s+(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting))?\s+(?:forward|onwards?|on)\b|\bstarting\s+(?:with|at)\s+(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting))?\b/i;

/** Deterministic "the whole series" phrasing across mutation requests. */
const RECURRENCE_SCOPE_SERIES_PATTERN =
  /\b(?:whole|entire|full)\s+series\b|\bthe\s+series\b|\ball\s+(?:occurrences|instances|of\s+them)\b|\bevery\s+(?:occurrence|instance|single\s+one)\b|\bstop\s+(?:it\s+)?(?:from\s+)?(?:repeating|recurring)\b|\bcancel\s+the\s+recurring\b/i;

/**
 * Structural resolution of one, following, or whole-series intent: explicit
 * `recurrenceScope` detail first, then unambiguous message phrasing. Returns
 * null when the intent stays ambiguous — the caller must ask instead of
 * mutating.
 */
function resolveRecurrenceScopeIntent(args: {
  details: Record<string, unknown> | undefined;
  text: string;
}): LifeOpsCalendarRecurrenceScope | null {
  const explicit = normalizeRecurrenceScope(
    detailString(args.details, "recurrenceScope"),
  );
  if (explicit) {
    return explicit;
  }
  const matchesInstance = RECURRENCE_SCOPE_INSTANCE_PATTERN.test(args.text);
  const matchesThisAndFollowing =
    RECURRENCE_SCOPE_THIS_AND_FOLLOWING_PATTERN.test(args.text);
  const matchesSeries = RECURRENCE_SCOPE_SERIES_PATTERN.test(args.text);
  const matches = [
    matchesInstance,
    matchesThisAndFollowing,
    matchesSeries,
  ].filter(Boolean).length;
  if (matches !== 1) {
    return null;
  }
  if (matchesInstance) return "instance";
  return matchesThisAndFollowing ? "this_and_following" : "series";
}

function isRecurringCalendarEvent(event: LifeOpsCalendarEvent | null): boolean {
  return Boolean(recurringEventIdFrom(event) || recurrenceLinesFrom(event));
}

function detailRecurrenceLines(
  details: Record<string, unknown> | undefined,
  key = "recurrence",
): string[] | undefined {
  if (!details) {
    return undefined;
  }
  const value = details[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    const lines = value
      .filter(
        (line): line is string =>
          typeof line === "string" && line.trim().length > 0,
      )
      .map((line) => line.trim());
    return lines.length > 0 ? lines : undefined;
  }
  return undefined;
}

function buildRecurrenceScopeClarification(args: {
  action: "update" | "delete";
  event: LifeOpsCalendarEvent;
}): string {
  const description =
    describeRecurrence(recurrenceLinesFrom(args.event)) ??
    "on a repeating schedule";
  const verb = args.action === "update" ? "change" : "delete";
  return `"${args.event.title}" repeats ${description}. should i ${verb} just this occurrence, this and every following occurrence, or the whole series?`;
}

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
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-action",
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
    "request: meetings with my colleague this week",
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
  error: CalendarServiceError,
  intent: string,
): string {
  const normalized = normalizeText(error.message);
  if (error.code === "CALENDAR_APPROVAL_GATEWAY_UNAVAILABLE") {
    return "Calendar changes are unavailable because the owner-approval gateway is not running. I did not change the calendar.";
  }
  if (
    error.code === "CALENDAR_MUTATION_CONTEXT_INCOMPLETE" ||
    error.code === "CALENDAR_MUTATION_CONTEXT_UNAVAILABLE"
  ) {
    return "I could not verify a complete, fresh view of every requested calendar source, so I did not queue or make a calendar change.";
  }
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
  if (
    error.status === 409 &&
    normalized.includes("apple calendar") &&
    (normalized.includes("attendee") ||
      normalized.includes("invitee") ||
      normalized.includes("invited meeting"))
  ) {
    return "Apple Calendar can't create or edit invited meetings from here. Connect Google Calendar for invites, or remove the attendees and I'll create it locally.";
  }
  return "I couldn't finish that calendar change yet. Tell me the event and timing again, and I'll try it a different way.";
}

function isAppleCalendarPermissionError(error: CalendarServiceError): boolean {
  return (
    error.status === 403 &&
    normalizeText(error.message).includes("apple calendar permission")
  );
}

function buildAppleCalendarPermissionRequestText(
  subaction: CalendarSubaction | null,
): string {
  const feature =
    subaction === "create_event"
      ? "lifeops.calendar.create"
      : subaction === "update_event"
        ? "lifeops.calendar.update"
        : subaction === "delete_event"
          ? "lifeops.calendar.delete"
          : "lifeops.calendar.read";
  const reason =
    subaction === "create_event"
      ? "I need Apple Calendar access to add that event."
      : subaction === "update_event"
        ? "I need Apple Calendar access to update that event."
        : subaction === "delete_event"
          ? "I need Apple Calendar access to delete that event."
          : "I need Apple Calendar access to read your schedule.";
  return [
    reason,
    "```json",
    JSON.stringify({
      action: "permission_request",
      reasoning:
        "native Apple Calendar access is required for this LifeOps calendar action",
      permission: "calendar",
      reason,
      feature,
      fallback_offered: false,
    }),
    "```",
  ].join("\n");
}

// titleHint comes from model extraction over the (possibly envelope-wrapped)
// message, so it can be an arbitrary blob — describeUserReference quotes it
// only when name-shaped and falls back to a neutral noun otherwise. Exported
// for regression tests.
export function buildCalendarEventDisambiguationFallback(args: {
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
    ? `I found multiple events matching ${describeUserReference(args.titleHint, "that event")}.`
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

// Same blob hazard as the disambiguation intro: the hint is model-extracted
// and must never be echoed verbatim when it is not name-shaped. Exported for
// regression tests.
export function buildCalendarEventNotFoundFallback(
  action: "update" | "delete",
  titleHint: string | undefined,
): string {
  return titleHint
    ? `i couldn't find an event matching ${describeUserReference(titleHint, "that event")} in that window.`
    : `i couldn't find any events to ${action} in that window. give me a title or a date.`;
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
  const renderGroundedReply = deps().renderGroundedReply;
  if (!renderGroundedReply) return fallback;
  return renderGroundedReply({
    runtime,
    message,
    state,
    intent,
    scenario,
    fallback,
    context,
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

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    // Some tool-model providers serialize an omitted string field as the
    // literal "unknown". Treat it as absent at this boundary so it cannot be
    // mistaken for an event ID, grant binding, date, or other real value.
    if (typeof value === "string" && value.trim().toLowerCase() === "unknown") {
      continue;
    }
    normalized[key] = value;
  }
  const aliasMap = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CALENDAR_DETAIL_ALIASES)) {
    aliasMap.set(normalizeLookupKey(canonical), canonical);
    for (const alias of aliases) {
      aliasMap.set(normalizeLookupKey(alias), canonical);
    }
  }

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string" && value.trim().toLowerCase() === "unknown") {
      continue;
    }
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

/**
 * Small spelled-out cardinals so everyday/child/elderly phrasing like "in two
 * days" or "a week from today" resolves deterministically, not just digits.
 */
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

/**
 * Resolve common relative-date phrasing to a day offset from today, or null.
 * Handles "today", "tomorrow", "yesterday", "day after tomorrow",
 * "day before yesterday", "in N days/weeks", and "N days/weeks from now|today"
 * (#8795). These are everyday phrasings the calendar action's own examples use
 * (e.g. "Schedule a meeting with Alex at 3pm tomorrow") that the deterministic
 * resolver previously returned null for, forcing an avoidable LLM round-trip.
 *
 * Multi-word and count patterns are checked before the bare "today"/"tomorrow"
 * words so "3 days from today" is +3, not 0.
 */
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

function resolveCalendarTimeZone(
  details: Record<string, unknown> | undefined,
): string {
  const requested = detailString(details, "timeZone");
  if (requested) {
    const normalized =
      CALENDAR_TIME_ZONE_ALIASES[requested.toLowerCase()] ?? requested;
    if (isValidTimeZone(normalized)) {
      return normalized;
    }
  }
  // Planner junk (e.g. "user's timezone") falls back to the agent default
  // instead of letting CalendarService reject the whole read with a 400.
  return resolveDefaultTimeZone();
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
  service: CalendarService,
  details: Record<string, unknown> | undefined,
  hasCalendarRead: boolean,
): Promise<CreateEventCalendarContext | null> {
  if (!hasCalendarRead) {
    return null;
  }

  const requestTimeZone = resolveCalendarTimeZone(details);
  const feed = await service.getCalendarFeed(INTERNAL_URL, {
    includeHiddenCalendars: true,
    mode: connectorModeDetail(details),
    side: connectorSideDetail(details),
    grantId: connectorGrantIdDetail(details),
    calendarId: calendarIdDetail(details),
    timeZone: requestTimeZone,
    forceSync: true,
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
// to find an upcoming birthday or a recent past meeting without scanning the
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

function formatCalendarLocalDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function buildCalendarLocalDateAnchors(now: Date, timeZone: string): string {
  const localDateParts = getZonedDateParts(now, timeZone);
  const localDate = {
    year: localDateParts.year,
    month: localDateParts.month,
    day: localDateParts.day,
  };
  return [
    `yesterday = ${formatCalendarLocalDate(addDaysToLocalDate(localDate, -1))}`,
    `today = ${formatCalendarLocalDate(localDate)}`,
    `tomorrow = ${formatCalendarLocalDate(addDaysToLocalDate(localDate, 1))}`,
  ].join(", ");
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
  const localDateAnchors = buildCalendarLocalDateAnchors(now, timeZone);
  const instructions = resolveOptimizedPromptForRuntime(
    runtime,
    "calendar_extract",
    CALENDAR_PLAN_INSTRUCTIONS,
  );
  const prompt = [
    instructions,
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
    const parsed = parseCalendarJsonRecord<Record<string, unknown>>(raw);
    return parsed ? buildCalendarPlanFromParsed(parsed) : null;
  };

  const plannerResult = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.plan",
    purpose: "calendar_extract",
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
    purpose: "calendar_extract",
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
  const travelIntent =
    injectedDeps?.travelBuffer?.resolveTravelIntent({
      details: args.details,
      extractedDetails: args.extractedDetails,
    }) ?? null;

  const explicitRecurrence = detailRecurrenceLines(args.details);
  const extractedRecurrence = detailRecurrenceLines(args.extractedDetails);
  const recurrence = args.preferExtractedDetails
    ? (extractedRecurrence ??
      explicitRecurrence ??
      args.fallbackRequest?.recurrence)
    : (explicitRecurrence ??
      extractedRecurrence ??
      args.fallbackRequest?.recurrence);

  return {
    title,
    resolvedStartAt,
    resolvedWindowPreset,
    travelIntent,
    request: {
      mode: connectorModeDetail(args.details) ?? args.fallbackRequest?.mode,
      side: connectorSideDetail(args.details) ?? args.fallbackRequest?.side,
      grantId: connectorGrantIdDetail(args.details),
      calendarId:
        calendarIdDetail(args.details) ??
        sanitizeCalendarId(args.fallbackRequest?.calendarId),
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
      recurrence,
    },
  };
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
  const recurring = isRecurringCalendarEvent(event);
  return [
    `title: ${event.title}`,
    `startAt: ${event.startAt}`,
    `endAt: ${event.endAt}`,
    `timeZone: ${event.timezone ?? ""}`,
    `formattedStart: ${formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    })}`,
    `location: ${event.location}`,
    `description: ${event.description}`,
    `attendees: ${attendees}`,
    `recurring: ${recurring ? "yes" : "no"}`,
    ...(recurring
      ? [
          `recurrenceDescription: ${
            describeRecurrence(recurrenceLinesFrom(event)) ?? "(unknown rule)"
          }`,
        ]
      : []),
  ].join("\n");
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
  const localDateAnchors = buildCalendarLocalDateAnchors(now, timeZone);
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
    "When the user asks for a repeating event (every day, every week, every two weeks, weekdays, every month, etc.), emit the matching RFC 5545 RRULE in recurrence. Use BYDAY for weekly day selection, INTERVAL for every-N spacing, and COUNT or UNTIL only when the user bounds the repetition. Leave recurrence empty for one-off events.",
    "",
    "title: event title",
    "description: optional description",
    "location: optional location",
    "startAt: RFC 3339 datetime if explicit or resolvable from a date phrase; include the numeric UTC offset that represents the requested wall-clock time in the calendar timezone",
    "endAt: RFC 3339 datetime if explicit; use the same offset rules as startAt",
    "durationMinutes: number if implied",
    "windowPreset: tomorrow_morning|tomorrow_afternoon|tomorrow_evening",
    "timeZone: IANA timezone if stated",
    "recurrence: RFC 5545 RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO or RRULE:FREQ=DAILY;COUNT=10, only for repeating events",
    "travelOriginAddress: optional origin address for travel-time calculation",
    "isShortPreparation: true|false",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `LOCAL DATE ANCHORS (authoritative — IGNORE UTC day for date arithmetic): ${localDateAnchors}.`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime (informational only — do NOT use for 'today/tomorrow/yesterday'): ${nowIso}`,
    "Resolve relative dates from the LOCAL DATE ANCHORS. Preserve the requested local clock time: for 9am in America/Los_Angeles emit 09:00 with the applicable -07:00/-08:00 offset, never 09:00Z. Use Z only when the calendar timezone is UTC.",
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
    "When the current event is part of a recurring series, set recurrenceScope to instance for only this occurrence, this_and_following for this occurrence and every later one, series for every occurrence including earlier ones, and leave it empty when the user does not say.",
    "Only set recurrence when the user changes how the event repeats (e.g. switch to weekly, stop after 5 times).",
    "Return JSON only as a single object. No prose.",
    "",
    "title: new event title if changed",
    "description: updated description if changed",
    "location: updated location if changed",
    "startAt: updated ISO datetime if changed",
    "endAt: updated ISO datetime if changed",
    "timeZone: IANA timezone if changed or needed to interpret the update",
    "recurrence: RFC 5545 RRULE string only when the repetition itself changes",
    "recurrenceScope: instance|this_and_following|series only when the current event is recurring and the user says which",
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
  const parsed = parseCalendarJsonRecord<Record<string, unknown>>(rawResponse);
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
    `location: ${candidate.event.location}`,
    `description: ${(candidate.event.description).slice(0, 240)}`,
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

// The query may be a raw user message or an LLM-extracted phrase — either can
// be a multi-line blob, so echoes go through describeUserReference. Exported
// for regression tests.
export function formatCalendarSearchResults(
  events: LifeOpsCalendarEvent[],
  query: string,
  label: string,
): string {
  const queryEcho = describeUserReference(query, "that request");
  if (events.length === 0) {
    return `No calendar events matched ${queryEcho} ${label}.`;
  }
  if (events.length === 1) {
    const event = events.at(0);
    if (!event) {
      return `No calendar events matched ${queryEcho} ${label}.`;
    }
    // The fallback wording is intentionally generic ("calendar event") so it
    // is correct in any language. The grounded LLM reply renderer is what
    // gives this string its final natural phrasing — no English keyword
    // regex picks the noun anymore.
    return `Your matching calendar event is **${event.title}** (${formatCalendarMoment(event)}).`;
  }
  const lines = [
    `Found ${events.length} calendar event${events.length === 1 ? "" : "s"} for ${queryEcho} ${label}:`,
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

type CalendarEffectIdentityValue = string | number | boolean | null;

function calendarEffectId(
  namespace: string,
  values: readonly CalendarEffectIdentityValue[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex");
  return `${namespace}:${digest}`;
}

function validCalendarTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestCalendarTimestamp(
  values: readonly (string | null | undefined)[],
  fallback: string,
): string {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const normalized = validCalendarTimestamp(value);
    if (!normalized) continue;
    const timestamp = Date.parse(normalized);
    if (timestamp > latestMs) {
      latest = normalized;
      latestMs = timestamp;
    }
  }
  return latest ?? fallback;
}

function calendarMessageObservedAt(message: Memory): string {
  const createdAt = message.createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return new Date(createdAt).toISOString();
  }
  return new Date().toISOString();
}

function calendarRequestNoopReceipt(args: {
  message: Memory;
  operation: string;
  discriminator?: string;
  reason: string;
}): EffectReceipt {
  const observedAt = calendarMessageObservedAt(args.message);
  const resourceId = calendarEffectId("calendar-request-resource-v1", [
    String(args.message.id),
    args.operation,
    args.discriminator ?? null,
  ]);
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-request-receipt-v1", [
      resourceId,
      observedAt,
      args.reason,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.request",
      id: resourceId,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason: args.reason,
  });
}

function calendarFailedReceipt(args: {
  message: Memory;
  operation: string;
  discriminator?: string;
  code: string;
  retryable: boolean;
  acceptance?: "rejected" | "unknown";
}): EffectReceipt {
  const observedAt = new Date().toISOString();
  const resourceId = calendarEffectId("calendar-operation-resource-v1", [
    String(args.message.id),
    args.operation,
    args.discriminator ?? null,
  ]);
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-failed-receipt-v1", [
      resourceId,
      args.code,
      observedAt,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.operation",
      id: resourceId,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "failed",
    failure: {
      code: args.code,
      retryable: args.retryable,
      acceptance: args.acceptance ?? "rejected",
    },
  });
}

function calendarFeedReadReceipt(args: {
  feed: LifeOpsCalendarFeed;
  operation: string;
  events?: readonly LifeOpsCalendarEvent[];
  discriminator?: string;
  reason?: string;
}): EffectReceipt {
  const events = args.events ?? args.feed.events;
  const eventVersions = [...events]
    .map((event) => [
      event.id,
      event.externalId,
      event.status,
      event.updatedAt,
      event.syncedAt,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const sourceVersions = args.feed.sources
    .map((source) => [
      source.status,
      source.syncedAt,
      source.changeDelivery?.status ?? null,
      source.changeDelivery?.lastSuccessfulSyncAt ?? null,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const resourceId = calendarEffectId("calendar-feed-resource-v1", [
    args.feed.calendarId,
    args.feed.timeMin,
    args.feed.timeMax,
    args.discriminator ?? null,
  ]);
  const version = calendarEffectId("calendar-feed-version-v1", [
    args.feed.state,
    args.feed.source,
    args.feed.syncedAt,
    JSON.stringify(sourceVersions),
    JSON.stringify(eventVersions),
  ]);
  const observedAt = latestCalendarTimestamp(
    [
      args.feed.syncedAt,
      ...args.feed.sources.flatMap((source) => [
        source.syncedAt,
        source.changeDelivery?.lastSuccessfulSyncAt,
        source.changeDelivery?.lastNotificationAt,
      ]),
      ...events.flatMap((event) => [event.updatedAt, event.syncedAt]),
    ],
    new Date().toISOString(),
  );
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-feed-read-receipt-v1", [
      args.operation,
      resourceId,
      version,
      observedAt,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.feed",
      id: resourceId,
      version,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason:
      args.reason ??
      "The operation read an authoritative calendar snapshot without changing it.",
  });
}

function calendarNextEventReadReceipt(
  context: LifeOpsNextCalendarEventContext,
): EffectReceipt {
  const event = context.event;
  const sourceVersions = context.calendarSources
    .map((source) => [
      source.status,
      source.syncedAt,
      source.changeDelivery?.status ?? null,
      source.changeDelivery?.lastSuccessfulSyncAt ?? null,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const resourceId = calendarEffectId("calendar-next-event-resource-v1", [
    event?.calendarId ?? null,
    event?.id ?? null,
  ]);
  const version = calendarEffectId("calendar-next-event-version-v1", [
    context.calendarFeedState,
    event?.externalId ?? null,
    event?.status ?? null,
    event?.updatedAt ?? null,
    event?.syncedAt ?? null,
    JSON.stringify(sourceVersions),
  ]);
  const observedAt = latestCalendarTimestamp(
    [
      event?.updatedAt,
      event?.syncedAt,
      ...context.calendarSources.flatMap((source) => [
        source.syncedAt,
        source.changeDelivery?.lastSuccessfulSyncAt,
        source.changeDelivery?.lastNotificationAt,
      ]),
    ],
    new Date().toISOString(),
  );
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-next-event-read-receipt-v1", [
      resourceId,
      version,
      observedAt,
    ]),
    operation: "calendar.event.next.read",
    resource: {
      kind: "calendar.next_event",
      id: resourceId,
      version,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason:
      "The operation read the next-event projection without changing calendar state.",
  });
}

function calendarApprovalReceipt(
  approval: CalendarMutationApprovalResult,
): EffectReceipt {
  const operation = `calendar.approval.${approval.action}`;
  const receiptId = calendarEffectId("calendar-approval-receipt-v1", [
    approval.requestId,
    approval.action,
    approval.state,
    approval.acceptedAt,
    approval.idempotencyKey,
    approval.replayed,
  ]);
  const base = {
    receiptId,
    operation,
    resource: {
      kind: "calendar.approval_request",
      id: approval.requestId,
      version: approval.state,
    },
    artifacts: [],
    idempotency: {
      key: approval.idempotencyKey,
      replayed: approval.replayed,
    },
    observedAt: approval.acceptedAt,
  } as const;
  return normalizeEffectReceipt(
    approval.replayed
      ? {
          ...base,
          outcome: "noop",
          reason:
            "The approval queue returned the existing idempotent request without persisting a duplicate.",
        }
      : {
          ...base,
          outcome: "applied",
          commit: {
            kind: "durable",
            id: approval.requestId,
            committedAt: approval.acceptedAt,
          },
        },
  );
}

function calendarEventMutationReceipt(args: {
  event: LifeOpsCalendarEvent;
  idempotencyKey: string;
  operation:
    | "calendar.event.create"
    | "calendar.event.update"
    | "calendar.event.delete";
  deleted?: boolean;
}): EffectReceipt {
  const observedAt = latestCalendarTimestamp(
    [args.event.updatedAt, args.event.syncedAt],
    new Date().toISOString(),
  );
  const providerVersion =
    typeof args.event.metadata.etag === "string"
      ? args.event.metadata.etag
      : args.event.updatedAt;
  const version = args.deleted ? `deleted:${providerVersion}` : providerVersion;
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-event-mutation-receipt-v1", [
      args.operation,
      args.event.id,
      version,
      args.idempotencyKey,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.event",
      id: args.event.id,
      version,
    },
    artifacts: [],
    idempotency: { key: args.idempotencyKey, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: args.event.id,
      committedAt: observedAt,
    },
  });
}

function localCalendarOperationKey(args: {
  message: Memory;
  operation: "create" | "update" | "delete";
  payload: unknown;
}): string {
  return calendarEffectId("calendar-local-operation-v1", [
    String(args.message.id),
    args.operation,
    JSON.stringify(args.payload),
  ]);
}

export type CalendarHandlerAction = Action & {
  suppressPostActionContinuation?: boolean;
};

/**
 * Build the inner calendar CRUD + LLM-intent action, wired to host-supplied
 * dependencies. The LifeOps `CALENDAR` umbrella delegates to this action's
 * handler after it has already gated owner access, so this handler trusts it
 * is running for an authorized owner and performs no access check of its own.
 */
export function createCalendarActionRunner(
  hostDeps: CalendarActionDeps,
): CalendarHandlerAction {
  injectedDeps = hostDeps;
  return calendarAction;
}

const calendarAction: CalendarHandlerAction = {
  name: "CALENDAR",
  similes: [
    "CALENDAR_ACTION",
    "CHECK_CALENDAR",
    "CALENDAR_READ",
    "CALENDAR_FEED",
    "CALENDAR_NEXT_EVENT",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_SEARCH_EVENTS",
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
    "domain:calendar",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "effect:receipt-required",
    "surface:remote-api",
  ],
  description:
    "Interact with live calendars through LifeOps. " +
    "USE this action for: viewing today's or this week's schedule; checking the next upcoming event; " +
    "searching events by title, attendee, location, or date range; creating new calendar events; " +
    "requests like 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', or 'schedule a dentist appointment next Tuesday at 3pm'; " +
    "querying travel itineraries, flights, hotel stays, trip windows, reserving recurring time blocks, and rebooking or moving calendar-backed commitments. " +
    "These are live calendar reads and writes, so do not answer them from provider context alone and do not fall back to NONE or REPLY when this action is available. " +
    "DO NOT use this action when the user is only making an observation like 'my calendar has been crazy this quarter' unless they actually ask you to inspect or change calendar state. " +
    "DO NOT use this action for email inbox work, drafting or sending emails — use MESSAGE with operation=triage, search_inbox, draft_reply, or send_draft (source=gmail for Gmail-specific work) instead. " +
    "DO NOT use this action for personal habits, goals, routines, or reminders — use OWNER_ROUTINES, OWNER_GOALS, or OWNER_REMINDERS instead. " +
    "DO NOT use this action to propose or suggest candidate meeting times to send to someone — use PROPOSE_MEETING_TIMES for requests like 'propose three times for a 30 min sync with X', 'suggest meeting slots', or 'find times that work next week'. The create_event subaction is only for booking a single known time on your own calendar. " +
    "This action provides the final grounded reply; do not pair it with a speculative REPLY action.",
  descriptionCompressed:
    "LifeOps calendar: view/search/create/query travel; not email/habits",
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  // Owner-access gating is performed by the LifeOps CALENDAR umbrella before it
  // delegates here, so this inner handler trusts an authorized owner.
  validate: async () => true,
  handler: async (
    runtime,
    message,
    state,
    options,
    callback?: HandlerCallback,
  ) => {
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
        detailString(details, "oldTitle") ||
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
        detailString(details, "oldTitle"),
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
    const service = resolveCalendarService(runtime);
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      text: string;
      data?: T;
      effectReceipt: EffectReceipt;
    }): Promise<ActionResult> => {
      const effectReceipt = normalizeEffectReceipt(payload.effectReceipt);
      const text = payload.text.trim();
      await callback?.({
        text,
        source: "action",
        action: "CALENDAR",
      });
      return {
        success: payload.success,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        // The callback above already delivered this exact text, and the action
        // description promises the final grounded reply. A calendar operation
        // is a single-operation turn whose delivered text IS the answer — on
        // success AND on failure ("calendar's acting up" is the complete
        // honest outcome) — so declare it complete: the gated-evaluator skip
        // keeps the model from re-rendering the delivery as a second message
        // ("clear tomorrow." / "you're clear tomorrow.", or a failure
        // paraphrase like "I couldn't verify... want me to try again?").
        turnComplete: true,
        effectReceipts: [effectReceipt],
        userFacingEffectReceiptIds: [effectReceipt.receiptId],
        ...(payload.data !== undefined ? { data: payload.data } : {}),
      };
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
        effectReceipt: calendarRequestNoopReceipt({
          message,
          operation: "calendar.request.evaluate",
          discriminator: llmPlan.subaction ?? undefined,
          reason:
            "The request required a conversational reply without executing a calendar operation.",
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
        effectReceipt: calendarRequestNoopReceipt({
          message,
          operation: "calendar.request.evaluate",
          discriminator: llmPlan.subaction ?? undefined,
          reason:
            "No unambiguous calendar operation was selected, so calendar state was unchanged.",
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
      if (subaction === "next_event") {
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
          effectReceipt: calendarNextEventReadReceipt(context),
          data: toActionData(context),
        });
      }

      if (subaction === "create_event") {
        const calendarContext = await loadCreateEventCalendarContext(
          service,
          details,
          true,
        );
        if (!calendarContext) {
          throw new CalendarServiceError(
            503,
            "Calendar create is blocked because current calendar context is unavailable.",
            "CALENDAR_MUTATION_CONTEXT_UNAVAILABLE",
          );
        }
        requireCompleteFreshCalendarFeed(calendarContext.feed, "create");
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
          // The outer planner identifies CALENDAR and supplies hints; this
          // domain-specific extraction has the authoritative calendar context,
          // timezone, and local-date anchors needed to normalize wall time.
          preferExtractedDetails: true,
        });
        const { title, resolvedStartAt, resolvedWindowPreset, request } =
          createEventBuild;
        const travelIntent = createEventBuild.travelIntent;
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
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.create",
              reason:
                "The create request was missing a title, so no approval or calendar event was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              requiresInput: true,
              missing: ["title"],
            },
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
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.create",
              discriminator: title,
              reason:
                "The create request was missing a time, so no approval or calendar event was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              requiresInput: true,
              missing: ["startAt"],
              title,
            },
          });
        }
        const requestToApprove = await service.prepareCalendarEventCreate(
          INTERNAL_URL,
          request,
        );
        const travel = injectedDeps?.travelBuffer;
        let travelBuffer: CalendarTravelBufferResult | undefined;
        if (travelIntent && travel) {
          try {
            travelBuffer = await travel.computeTravelBuffer({
              runtime,
              event: {
                id: "pending-calendar-approval",
                location: requestToApprove.location ?? "",
              },
              travelIntent,
            });
          } catch (error) {
            if (travel.isTravelTimeUnavailable(error)) {
              return respond({
                success: false,
                text: `I couldn't prepare the travel buffer, so I did not queue or create the event: ${error.message}`,
                effectReceipt: calendarFailedReceipt({
                  message,
                  operation: "calendar.travel_buffer.prepare",
                  discriminator: title,
                  code: error.code,
                  retryable: true,
                }),
                data: {
                  actionName: "CALENDAR",
                  subaction: "create_event",
                  approvalRequired: true,
                  error: error.code,
                },
              });
            }
            throw error;
          }
        }
        if (requestToApprove.grantId === ELIZA_CALENDAR_GRANT_ID) {
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "create",
            payload: requestToApprove,
          });
          const createdEvent = await service.createCalendarEvent(INTERNAL_URL, {
            ...requestToApprove,
            idempotencyKey,
          });
          if (travelBuffer && travel) {
            await travel.reserveTravelBuffer({
              runtime,
              eventId: createdEvent.id,
              travelBuffer,
            });
          }
          const fallback = `Created “${createdEvent.title}” for ${formatCalendarEventDateTime(
            createdEvent,
            { includeTimeZoneName: true },
          )}.`;
          return respond({
            success: true,
            text: await renderReply("create_event_completed", fallback, {
              event: createdEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: createdEvent,
              idempotencyKey,
              operation: "calendar.event.create",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              approvalRequired: false,
              event: createdEvent,
              ...(travelBuffer ? { travelBuffer } : {}),
            },
          });
        }
        const approval = await requireCalendarMutationGateway().schedule({
          runtime,
          message,
          request: requestToApprove,
          ...(travelBuffer ? { travelBuffer } : {}),
        });
        return respond({
          success: true,
          text: approval.text,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "create_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: requestToApprove,
            ...(travelBuffer ? { travelBuffer } : {}),
          },
        });
      }

      if (subaction === "update_event") {
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
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                reason:
                  "The update request did not identify a target, so no approval or calendar event was changed.",
              }),
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
          const feed = requireCompleteFreshCalendarFeed(
            await service.getCalendarFeed(INTERNAL_URL, {
              includeHiddenCalendars: true,
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              forceSync: true,
              ...feedRequest,
            }),
            "update",
          );
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = buildCalendarEventNotFoundFallback(
              "update",
              titleHint,
            );
            return respond({
              success: false,
              text: await renderReply("update_event_not_found", fallback, {
                titleHint: userReferenceLogView(titleHint),
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "No matching event was found, so no update approval was created.",
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
                titleHint: userReferenceLogView(titleHint),
                candidates,
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "Multiple events matched the request, so no update approval was created.",
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
                { titleHint: userReferenceLogView(titleHint) },
              ),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "A unique target could not be resolved, so no update approval was created.",
              }),
            });
          }
          resolvedEventId = targetEvent.externalId;
          resolvedCalendarId = targetEvent.calendarId;
        }
        if (!resolvedEventId) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_update_event_target",
              "i need an event id or a title + date to update an event.",
              {
                missing: ["event target"],
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.update",
              reason:
                "The update request did not resolve an event identifier, so calendar state was unchanged.",
            }),
          });
        }
        if (!targetEvent) {
          targetEvent = await service.getConditionalCalendarMutationTarget(
            INTERNAL_URL,
            {
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              calendarId: resolvedCalendarId,
              eventId: resolvedEventId,
            },
          );
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
              targetEvent.timezone ?? planningTimeZone,
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
        const recurrenceUpdate =
          detailRecurrenceLines(details) ??
          detailRecurrenceLines(extractedForUpdate);
        let recurrenceScopeForUpdate = resolveRecurrenceScopeIntent({
          details,
          text: `${messageText(message)} ${intent}`,
        });
        if (!recurrenceScopeForUpdate) {
          recurrenceScopeForUpdate =
            normalizeRecurrenceScope(
              typeof extractedForUpdate.recurrenceScope === "string"
                ? extractedForUpdate.recurrenceScope
                : undefined,
            ) ?? null;
        }
        // A recurrence-rule change is inherently a series edit.
        if (recurrenceUpdate && !recurrenceScopeForUpdate) {
          recurrenceScopeForUpdate = "series";
        }
        // Mutating a recurring event without explicit occurrence/following/
        // series intent is ambiguous: ask instead of guessing.
        if (
          targetEvent &&
          isRecurringCalendarEvent(targetEvent) &&
          !recurrenceScopeForUpdate
        ) {
          const fallback = buildRecurrenceScopeClarification({
            action: "update",
            event: targetEvent,
          });
          return respond({
            success: false,
            text: await renderReply(
              "clarify_update_event_recurrence_scope",
              fallback,
              {
                event: targetEvent,
                recurrenceDescription: describeRecurrence(
                  recurrenceLinesFrom(targetEvent),
                ),
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.update",
              discriminator: resolvedEventId,
              reason:
                "The recurrence scope was ambiguous, so no update approval was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "update_event",
              requiresInput: true,
              missing: ["recurrenceScope"],
              eventId: resolvedEventId,
            },
          });
        }

        const grantId = targetEvent.grantId?.trim();
        if (!grantId) {
          throw new CalendarServiceError(
            409,
            "Calendar update is blocked because the target account binding is missing.",
            "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
          );
        }
        const updateRequest = {
          side: targetEvent.side,
          grantId,
          calendarId: targetEvent.calendarId,
          eventId: targetEvent.externalId,
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
          recurrence: recurrenceUpdate,
          recurrenceScope: recurrenceScopeForUpdate ?? undefined,
          notifyAttendees: detailBoolean(details, "notifyAttendees") === true,
        };
        if (targetEvent.provider === ELIZA_CALENDAR_PROVIDER) {
          const expectedProviderVersion = targetEvent.metadata.etag;
          if (typeof expectedProviderVersion !== "string") {
            throw new CalendarServiceError(
              409,
              "The built-in calendar event is missing its version. Refresh and try again.",
              "ELIZA_CALENDAR_VERSION_REQUIRED",
            );
          }
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "update",
            payload: updateRequest,
          });
          const updatedEvent = await service.updateCalendarEvent(INTERNAL_URL, {
            ...updateRequest,
            expectedProviderVersion,
            idempotencyKey,
          });
          const fallback = `Updated “${updatedEvent.title}” for ${formatCalendarEventDateTime(
            updatedEvent,
            { includeTimeZoneName: true },
          )}.`;
          return respond({
            success: true,
            text: await renderReply("update_event_completed", fallback, {
              event: updatedEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: updatedEvent,
              idempotencyKey,
              operation: "calendar.event.update",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "update_event",
              approvalRequired: false,
              event: updatedEvent,
              targetEvent,
            },
          });
        }
        const approval = await requireCalendarMutationGateway().modify({
          runtime,
          message,
          targetEvent,
          request: updateRequest,
        });
        return respond({
          success: true,
          text: approval.text,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "update_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: updateRequest,
            targetEvent,
            ...(recurrenceScopeForUpdate
              ? { recurrenceScope: recurrenceScopeForUpdate }
              : {}),
          },
        });
      }

      if (subaction === "delete_event") {
        const explicitEventId = detailString(details, "eventId");
        let targetEvent: LifeOpsCalendarEvent | null = null;
        const recurrenceScopeForDelete = resolveRecurrenceScopeIntent({
          details,
          text: `${messageText(message)} ${intent}`,
        });
        if (!explicitEventId) {
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
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                reason:
                  "The delete request did not identify a target, so no approval or calendar event was changed.",
              }),
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
          const feed = requireCompleteFreshCalendarFeed(
            await service.getCalendarFeed(INTERNAL_URL, {
              includeHiddenCalendars: true,
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              forceSync: true,
              ...feedRequest,
            }),
            "delete",
          );
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = buildCalendarEventNotFoundFallback(
              "delete",
              titleHint,
            );
            return respond({
              success: false,
              text: await renderReply("delete_event_not_found", fallback, {
                titleHint: userReferenceLogView(titleHint),
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "No matching event was found, so no cancellation approval was created.",
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
                titleHint: userReferenceLogView(titleHint),
                candidates,
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "Multiple events matched the request, so no cancellation approval was created.",
              }),
            });
          }
          targetEvent = candidates[0] ?? null;
        } else {
          targetEvent = await service.getConditionalCalendarMutationTarget(
            INTERNAL_URL,
            {
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              calendarId: detailString(details, "calendarId"),
              eventId: explicitEventId,
            },
          );
        }
        if (!targetEvent) {
          return respond({
            success: false,
            text: await renderReply(
              "delete_event_not_found",
              "i couldn't find a unique event to delete.",
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.delete",
              reason:
                "A unique target could not be resolved, so no cancellation approval was created.",
            }),
          });
        }
        if (
          isRecurringCalendarEvent(targetEvent) &&
          !recurrenceScopeForDelete
        ) {
          const fallback = buildRecurrenceScopeClarification({
            action: "delete",
            event: targetEvent,
          });
          return respond({
            success: false,
            text: await renderReply(
              "clarify_delete_event_recurrence_scope",
              fallback,
              {
                event: targetEvent,
                recurrenceDescription: describeRecurrence(
                  recurrenceLinesFrom(targetEvent),
                ),
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.delete",
              discriminator: targetEvent.externalId,
              reason:
                "The recurrence scope was ambiguous, so no cancellation approval was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "delete_event",
              requiresInput: true,
              missing: ["recurrenceScope"],
              eventId: targetEvent.externalId,
            },
          });
        }
        const grantId = targetEvent.grantId?.trim();
        if (!grantId) {
          throw new CalendarServiceError(
            409,
            "Calendar cancellation is blocked because the target account binding is missing.",
            "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
          );
        }
        const cancelRequest = {
          side: targetEvent.side,
          grantId,
          calendarId: targetEvent.calendarId,
          eventId: targetEvent.externalId,
          ...(recurrenceScopeForDelete
            ? { recurrenceScope: recurrenceScopeForDelete }
            : {}),
          notifyAttendees: detailBoolean(details, "notifyAttendees") === true,
        };
        if (targetEvent.provider === ELIZA_CALENDAR_PROVIDER) {
          const expectedProviderVersion = targetEvent.metadata.etag;
          if (typeof expectedProviderVersion !== "string") {
            throw new CalendarServiceError(
              409,
              "The built-in calendar event is missing its version. Refresh and try again.",
              "ELIZA_CALENDAR_VERSION_REQUIRED",
            );
          }
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "delete",
            payload: cancelRequest,
          });
          await service.deleteCalendarEvent(INTERNAL_URL, {
            ...cancelRequest,
            expectedProviderVersion,
            idempotencyKey,
          });
          const fallback = `Deleted “${targetEvent.title}” from your calendar.`;
          return respond({
            success: true,
            text: await renderReply("delete_event_completed", fallback, {
              event: targetEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: targetEvent,
              idempotencyKey,
              operation: "calendar.event.delete",
              deleted: true,
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "delete_event",
              approvalRequired: false,
              deleted: true,
              targetEvent,
            },
          });
        }
        const approval = await requireCalendarMutationGateway().cancel({
          runtime,
          message,
          targetEvent,
          request: cancelRequest,
        });
        return respond({
          success: true,
          text: approval.text,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "delete_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: cancelRequest,
            targetEvent,
          },
        });
      }

      if (subaction === "trip_window" && tripWindowIntent) {
        const feed = await service.getCalendarFeed(INTERNAL_URL, {
          includeHiddenCalendars: true,
          mode: connectorModeDetail(details),
          side: connectorSideDetail(details),
          grantId: connectorGrantIdDetail(details),
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
            effectReceipt: calendarFeedReadReceipt({
              feed,
              events: [],
              operation: "calendar.trip_window.read",
              discriminator: tripWindowIntent.location,
              reason:
                "The trip-window lookup completed without finding a matching itinerary and changed no calendar state.",
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
          effectReceipt: calendarFeedReadReceipt({
            feed,
            events: itineraryEvents,
            operation: "calendar.trip_window.read",
            discriminator: tripWindowIntent.location,
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
        mode: connectorModeDetail(details),
        side: connectorSideDetail(details),
        grantId: connectorGrantIdDetail(details),
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
              // Echo the user's actual words, not the external-content
              // security envelope hardenIncomingUserMessage may have wrapped
              // around content.text; the raw text stays in currentMessageText
              // for the inference calls above/below.
              const queryFallback =
                unwrapUserMessageText(message) || intent || "your request";
              const fallback = formatCalendarSearchResults(
                filteredEvents,
                queryFallback,
                label,
              );
              return respond({
                success: true,
                text: await renderReply("search_results", fallback, {
                  query: userReferenceLogView(queryFallback),
                  queries: [],
                  events: filteredEvents,
                  label,
                }),
                effectReceipt: calendarFeedReadReceipt({
                  feed,
                  events: filteredEvents,
                  operation: "calendar.event.search",
                  discriminator: userReferenceLogView(queryFallback),
                }),
                data: toActionData({
                  ...feed,
                  query: userReferenceLogView(queryFallback),
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
                effectReceipt: calendarFeedReadReceipt({
                  feed,
                  operation: "calendar.feed.read",
                  discriminator: label,
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
              effectReceipt: calendarFeedReadReceipt({
                feed,
                operation: "calendar.feed.read",
                discriminator: label,
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
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.search",
              reason:
                "The search target remained ambiguous, so no calendar lookup result was claimed.",
            }),
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
        // queriesForSearch values are LLM-extracted and can be blobs; clamp
        // every machine-facing render while matching above kept the raw values.
        const queryViews = queriesForSearch.map((value) =>
          userReferenceLogView(value),
        );
        return respond({
          success: true,
          text: await renderReply("search_results", fallback, {
            query: userReferenceLogView(query),
            queries: queryViews,
            events: filteredEvents,
            label,
          }),
          effectReceipt: calendarFeedReadReceipt({
            feed,
            events: filteredEvents,
            operation: "calendar.event.search",
            discriminator: userReferenceLogView(JSON.stringify(queryViews)),
          }),
          data: toActionData({
            ...feed,
            query: userReferenceLogView(query),
            queries: queryViews,
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
        effectReceipt: calendarFeedReadReceipt({
          feed,
          operation: "calendar.feed.read",
          discriminator: label,
        }),
        data: toActionData(feed),
      });
    } catch (error) {
      if (error instanceof CalendarServiceError) {
        if (isAppleCalendarPermissionError(error)) {
          return respond({
            success: false,
            text: buildAppleCalendarPermissionRequestText(subaction),
            effectReceipt: calendarFailedReceipt({
              message,
              operation: `calendar.${subaction}`,
              code: error.code ?? "APPLE_CALENDAR_PERMISSION_REQUIRED",
              retryable: false,
            }),
          });
        }
        // The failure receipt carries only a code; without the service
        // error's message and the request hints the operator cannot see WHICH
        // validation or provider call rejected the turn (live 2026-08-09: a
        // swallowed "mode must be one of ..." surfaced only as
        // CALENDAR_SERVICE_400).
        runtime.reportError("calendar:action", error, {
          subaction: subaction ?? "none",
          status: error.status,
          code: error.code ?? `CALENDAR_SERVICE_${error.status}`,
          detail: error.message,
          calendarId: detailString(details, "calendarId") ?? "unset",
          timeMin: detailString(details, "timeMin") ?? "unset",
          timeMax: detailString(details, "timeMax") ?? "unset",
          timeZone: detailString(details, "timeZone") ?? "unset",
          mode: detailString(details, "mode") ?? "unset",
          side: detailString(details, "side") ?? "unset",
          grantId: detailString(details, "grantId") ?? "unset",
        });
        const fallback = buildCalendarServiceErrorFallback(error, intent);
        return respond({
          success: false,
          text: await renderReply("service_error", fallback, {
            status: error.status,
            subaction,
          }),
          effectReceipt: calendarFailedReceipt({
            message,
            operation: `calendar.${subaction}`,
            code: error.code ?? `CALENDAR_SERVICE_${error.status}`,
            retryable: error.status >= 500,
            acceptance:
              subaction === "create_event" ||
              subaction === "update_event" ||
              subaction === "delete_event"
                ? "unknown"
                : "rejected",
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
        "Optional structured calendar fields such as time bounds, timezone, calendar id, create-event timing, location, attendees, " +
        "start/end datetimes must be RFC 3339 with a numeric offset matching timeZone (use Z only for UTC); " +
        'recurrence (RFC 5545 RRULE line(s) like "RRULE:FREQ=WEEKLY;BYDAY=MO" for repeating events), and recurrenceScope ' +
        '("instance" for one occurrence, "this_and_following" to split at the selected occurrence, "series" for the whole series).',
      required: false,
      schema: CALENDAR_DETAILS_PARAMETER_SCHEMA,
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
          text: "Need to book 1 hour per day for time with my partner. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a recurring daily one-hour block, placed before your sleep window when possible.",
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
