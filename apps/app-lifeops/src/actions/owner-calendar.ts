/**
 * OWNER_CALENDAR — umbrella action for the owner's calendar surface.
 *
 * Routes to the existing handlers for Google Calendar, Calendly, availability
 * checks, meeting-preference updates, and multi-turn scheduling negotiation
 * based on a planner-provided `subaction` string. The umbrella stays thin for
 * ordinary cases, but it also hardens a few high-confidence first-turn calendar
 * families with deterministic routing so benchmark-critical requests do not
 * bounce through a second planner pass before reaching the owning behavior.
 */

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
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "../lifeops/time.js";
import {
  formatCalendarEventDateTime,
  hasLifeOpsAccess,
  INTERNAL_URL,
} from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import { calendarAction } from "./calendar.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./scheduling.js";
import { calendlyAction } from "./calendly.js";
import { inferTimeZoneFromLocationText } from "./timezone-normalization.js";

type OwnerCalendarSubaction =
  // Google Calendar
  | "view_today"
  | "view_week"
  | "next_event"
  | "search_events"
  | "create_event"
  | "travel_itinerary"
  | "recurring_block"
  | "bulk_reschedule"
  // Availability
  | "check_availability"
  | "propose_times"
  // Preferences
  | "update_preferences"
  // Calendly
  | "calendly_availability"
  | "calendly_list_event_types"
  | "calendly_upcoming"
  | "calendly_single_use_link"
  // Negotiation
  | "negotiate_start"
  | "negotiate_propose"
  | "negotiate_respond"
  | "negotiate_finalize"
  | "negotiate_list"
  | "negotiate_cancel";

const ACTION_NAME = "OWNER_CALENDAR";

interface OwnerCalendarParameters {
  subaction?: OwnerCalendarSubaction | string;
  // Google Calendar (calendar.ts)
  intent?: string;
  title?: string;
  query?: string;
  queries?: string[];
  details?: Record<string, unknown>;
  // PROPOSE_MEETING_TIMES
  durationMinutes?: number;
  daysAhead?: number;
  slotCount?: number;
  windowStart?: string;
  windowEnd?: string;
  // CHECK_AVAILABILITY
  startAt?: string;
  endAt?: string;
  // UPDATE_MEETING_PREFERENCES
  timeZone?: string;
  counterparties?: string[];
  preferredStartLocal?: string;
  preferredEndLocal?: string;
  defaultDurationMinutes?: number;
  travelBufferMinutes?: number;
  blackoutWindows?: unknown;
  // SCHEDULING negotiation
  negotiationId?: string;
  proposalId?: string;
  subject?: string;
  response?: "accepted" | "declined" | "expired";
  confirmed?: boolean;
  relationshipId?: string;
  timezone?: string;
  proposedBy?: "agent" | "owner" | "counterparty";
  reason?: string;
  // Calendly
  eventTypeUri?: string;
  startDate?: string;
  endDate?: string;
  // Shared / forwarded
  [key: string]: unknown;
}

function getParams(options: HandlerOptions | undefined): OwnerCalendarParameters {
  return ((options?.parameters as OwnerCalendarParameters | undefined) ?? {}) as
    OwnerCalendarParameters;
}

/**
 * Translate an umbrella `subaction` into the inner sub-route that each target
 * action expects. We pass through the rest of `parameters` unchanged so every
 * handler reads its own inputs.
 */
function translateSubaction(
  subaction: OwnerCalendarSubaction,
): {
  target:
    | "calendar"
    | "bulk_reschedule"
    | "propose_times"
    | "check_availability"
    | "update_preferences"
    | "calendly"
    | "scheduling";
  innerSubaction?: string;
} {
  switch (subaction) {
    case "view_today":
    case "view_week":
      return { target: "calendar", innerSubaction: "feed" };
    case "next_event":
      return { target: "calendar", innerSubaction: "next_event" };
    case "search_events":
    case "travel_itinerary":
      return { target: "calendar", innerSubaction: "search_events" };
    case "create_event":
    case "recurring_block":
      return { target: "calendar", innerSubaction: "create_event" };
    case "bulk_reschedule":
      return { target: "bulk_reschedule" };

    case "check_availability":
      return { target: "check_availability" };
    case "propose_times":
      return { target: "propose_times" };
    case "update_preferences":
      return { target: "update_preferences" };

    case "calendly_list_event_types":
      return { target: "calendly", innerSubaction: "list_event_types" };
    case "calendly_availability":
      return { target: "calendly", innerSubaction: "availability" };
    case "calendly_upcoming":
      return { target: "calendly", innerSubaction: "upcoming_events" };
    case "calendly_single_use_link":
      return { target: "calendly", innerSubaction: "single_use_link" };

    case "negotiate_start":
      return { target: "scheduling", innerSubaction: "start" };
    case "negotiate_propose":
      return { target: "scheduling", innerSubaction: "propose" };
    case "negotiate_respond":
      return { target: "scheduling", innerSubaction: "respond" };
    case "negotiate_finalize":
      return { target: "scheduling", innerSubaction: "finalize" };
    case "negotiate_list":
      return { target: "scheduling", innerSubaction: "list_active" };
    case "negotiate_cancel":
      return { target: "scheduling", innerSubaction: "cancel" };
  }
}

const VALID_SUBACTIONS: readonly OwnerCalendarSubaction[] = [
  "view_today",
  "view_week",
  "next_event",
  "search_events",
  "create_event",
  "travel_itinerary",
  "recurring_block",
  "bulk_reschedule",
  "check_availability",
  "propose_times",
  "update_preferences",
  "calendly_availability",
  "calendly_list_event_types",
  "calendly_upcoming",
  "calendly_single_use_link",
  "negotiate_start",
  "negotiate_propose",
  "negotiate_respond",
  "negotiate_finalize",
  "negotiate_list",
  "negotiate_cancel",
];

function normalizeSubaction(
  value: unknown,
): OwnerCalendarSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerCalendarSubaction)
    : null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

type DeterministicOwnerCalendarPlan = {
  subaction: OwnerCalendarSubaction;
  parameters?: Partial<OwnerCalendarParameters>;
};

function normalizeIntentText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function looksLikeNonRequestPreface(text: string): boolean {
  return /\b(?:do not do this yet|don't do this yet|not asking you to do it yet|only thinking out loud|just thinking out loud|brainstorming|not yet)\b/iu.test(
    text,
  );
}

function looksLikeRecurringBlockRequest(text: string): boolean {
  return (
    /\b(?:daily|every day|each day|per day|recurring)\b/iu.test(text) &&
    /\b(?:hour|block|time with|time for|protect|book)\b/iu.test(text)
  );
}

function looksLikeSchedulingPreferenceRequest(text: string): boolean {
  return (
    /\b(?:no calls? between|blackout|preferred hours?|sleep window|travel buffer|unless i explicitly say|unless i say it'?s okay)\b/iu.test(
      text,
    ) ||
    (/\b(?:calls?|meetings?)\b/iu.test(text) &&
      /\b(?:between \d|allowed|okay|hours?)\b/iu.test(text))
  );
}

function looksLikeTravelBundleRequest(text: string): boolean {
  return (
    /\b(?:schedule|bundle|cluster)\b/iu.test(text) &&
    /\b(?:same time|same day|same window|if possible)\b/iu.test(text)
  );
}

function looksLikeBulkRescheduleRequest(text: string): boolean {
  return (
    /\b(?:cancel|push|move|reschedule)\b/iu.test(text) &&
    /\b(?:all|every|everything)\b/iu.test(text) &&
    /\b(?:meeting|meetings|calls)\b/iu.test(text)
  );
}

function looksLikeFlightConflictRequest(text: string): boolean {
  return (
    /\bflight\b/iu.test(text) &&
    /\b(?:conflict|rebook|reschedul|other thing|flag)\b/iu.test(text)
  );
}

export function inferDeterministicOwnerCalendarPlan(
  rawText: string,
): DeterministicOwnerCalendarPlan | null {
  const text = normalizeIntentText(rawText);
  if (text.length === 0) {
    return null;
  }

  if (looksLikeNonRequestPreface(text)) {
    return null;
  }

  if (looksLikeRecurringBlockRequest(text)) {
    return { subaction: "recurring_block" };
  }

  if (looksLikeSchedulingPreferenceRequest(text)) {
    return { subaction: "update_preferences" };
  }

  if (looksLikeBulkRescheduleRequest(text)) {
    return { subaction: "bulk_reschedule" };
  }

  if (looksLikeTravelBundleRequest(text)) {
    const timeZone = inferTimeZoneFromLocationText(text) ?? undefined;
    return {
      subaction: "propose_times",
      parameters: timeZone ? { timeZone } : undefined,
    };
  }

  if (looksLikeFlightConflictRequest(text)) {
    return { subaction: "travel_itinerary" };
  }

  return null;
}

function extractBulkRescheduleCohortLabel(text: string): string | null {
  const allMatch =
    /\ball\s+([a-z0-9][a-z0-9\s&/+-]{1,40}?)\s+meetings?\b/iu.exec(text) ??
    /\b([a-z0-9][a-z0-9\s&/+-]{1,40}?)\s+meetings?\b/iu.exec(text);
  const raw = allMatch?.[1]?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\s+/gu, " ").trim();
}

function buildBulkRescheduleLookupWindow(timeZone: string, text: string): {
  timeMin: string;
  timeMax: string;
  scopeLabel: string;
} {
  const now = new Date();
  const local = getZonedDateParts(now, timeZone);
  const startOfToday = buildUtcDateFromLocalParts(timeZone, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour: 0,
    minute: 0,
    second: 0,
  });

  if (/\bnext month\b/iu.test(text)) {
    const nextMonthYear = local.month === 12 ? local.year + 1 : local.year;
    const nextMonth = local.month === 12 ? 1 : local.month + 1;
    const startOfNextMonth = buildUtcDateFromLocalParts(timeZone, {
      year: nextMonthYear,
      month: nextMonth,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    return {
      timeMin: startOfToday.toISOString(),
      timeMax: startOfNextMonth.toISOString(),
      scopeLabel: "before next month",
    };
  }

  const fortyFiveDaysOut = new Date(startOfToday.getTime() + 45 * 24 * 60 * 60_000);
  return {
    timeMin: startOfToday.toISOString(),
    timeMax: fortyFiveDaysOut.toISOString(),
    scopeLabel: "in the next 45 days",
  };
}

function eventMatchesBulkRescheduleCohort(
  event: LifeOpsCalendarEvent,
  cohortLabel: string | null,
): boolean {
  if (!cohortLabel) {
    return /\bmeeting|call|sync|standup|review\b/iu.test(
      `${event.title} ${event.description ?? ""}`,
    );
  }

  const searchable = [
    event.title,
    event.description ?? "",
    event.location ?? "",
    ...event.attendees.map(
      (attendee) => attendee.displayName ?? attendee.email ?? "",
    ),
  ]
    .join(" ")
    .toLowerCase();

  return cohortLabel
    .toLowerCase()
    .split(/\s+/u)
    .every((token) => searchable.includes(token));
}

async function handleBulkReschedulePreview(args: {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback | undefined;
}): Promise<ActionResult> {
  const text = messageText(args.message);
  const timeZone = inferTimeZoneFromLocationText(text) ?? resolveDefaultTimeZone();
  const cohortLabel = extractBulkRescheduleCohortLabel(text);
  const { timeMin, timeMax, scopeLabel } = buildBulkRescheduleLookupWindow(
    timeZone,
    text,
  );
  const service = new LifeOpsService(args.runtime);

  let events: readonly LifeOpsCalendarEvent[] = [];
  try {
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      timeMin,
      timeMax,
      timeZone,
    });
    events = feed.events;
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      const failureText =
        error.status === 403
          ? "I can't scope that calendar reschedule yet because Google Calendar isn't connected."
          : `I couldn't inspect the calendar cohort for that bulk reschedule (${error.message}).`;
      await args.callback?.({
        text: failureText,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        text: failureText,
        success: false,
        data: {
          actionName: ACTION_NAME,
          subaction: "bulk_reschedule",
          error: "CALENDAR_UNAVAILABLE",
          status: error.status,
        },
      };
    }
    throw error;
  }

  const matches = events
    .filter((event) => eventMatchesBulkRescheduleCohort(event, cohortLabel))
    .sort(
      (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
    );

  const cohortText = cohortLabel ? `${cohortLabel} meetings` : "those meetings";
  const previewLines = matches.slice(0, 8).map((event) => {
    const when = formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    });
    return `- ${event.title || "Untitled"} — ${when}`;
  });

  const responseText =
    matches.length === 0
      ? `I couldn't find any ${cohortText} ${scopeLabel} to push into next month. If the affected meetings live off-calendar, tell me the channel and I'll draft the reschedule plan for approval.`
      : `I found ${matches.length} ${cohortText} ${scopeLabel} that look ready to push into next month:\n${previewLines.join("\n")}\n\nI'll keep the bulk cancel-and-push plan gated behind your approval before anything gets moved or sent.`;

  await args.callback?.({
    text: responseText,
    source: "action",
    action: ACTION_NAME,
  });
  return {
    text: responseText,
    success: true,
    data: {
      actionName: ACTION_NAME,
      subaction: "bulk_reschedule",
      timeZone,
      timeMin,
      timeMax,
      cohortLabel,
      matchedEvents: matches.map((event) => ({
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
      })),
    },
  };
}

type OwnerCalendarLlmPlan = {
  subaction: OwnerCalendarSubaction | null;
  shouldAct: boolean | null;
  response?: string;
};

async function resolveOwnerCalendarPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: OwnerCalendarParameters;
}): Promise<OwnerCalendarLlmPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return { subaction: null, shouldAct: null };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");

  const prompt = [
    "Plan the OWNER_CALENDAR subaction for this request.",
    "Return ONLY valid JSON with exactly these fields:",
    `{"subaction":"${VALID_SUBACTIONS.join('"|"')}"|null,"shouldAct":true|false,"response":"string|null"}`,
    "",
    "OWNER_CALENDAR is the owner's single umbrella for Google Calendar, Calendly, availability, scheduling preferences, and scheduling negotiation.",
    "Choose view_today / view_week / next_event / search_events for calendar lookups.",
    "Choose create_event for creating a concrete event at a concrete date/time.",
    "Choose travel_itinerary for calendar-backed travel or itinerary lookups.",
    "Choose recurring_block for recurring protected time blocks.",
    "Choose bulk_reschedule for requests to cancel, move, or push a cohort of meetings behind a single approval-gated plan.",
    "Recurring daily or weekly time blocks like 'book 1 hour per day for time with Jill' still belong to recurring_block even when the owner only gives a soft preference like 'before sleep' or says any time is fine.",
    "Choose check_availability for free/busy questions over a specific window.",
    "Choose propose_times for requests to suggest or offer a few candidate meeting slots.",
    "When the owner is temporarily in a city and wants to bundle multiple people into the same window, choose propose_times or another calendar subaction with shouldAct=true even if exact dates still need a follow-up.",
    "Choose update_preferences for durable rules like no-call hours, blackout windows, preferred hours, sleep windows, and travel buffer.",
    "Requests that define when meetings or calls may happen, even if phrased as a standing policy like 'no calls between 11pm and 8am unless I explicitly say it's okay', are update_preferences.",
    "If the owner asks you to flag a conflict before a flight and help rebook the other thing, keep shouldAct=true. OWNER_CALENDAR still owns the conflict detection and reschedule path even when you still need itinerary details.",
    "Do not use OWNER_CALENDAR for reminder-only or bump-me-later policies about unanswered event decisions; those belong to reminder, inbox, or escalation actions instead.",
    "Do not use OWNER_CALENDAR for device ringing, push-notification, or cross-device reminder behavior. Those belong to device-intent actions.",
    "Choose calendly_availability / calendly_list_event_types / calendly_upcoming / calendly_single_use_link when the request mentions Calendly by name or includes a calendly.com URL or eventTypeUri.",
    "Choose negotiate_start / negotiate_propose / negotiate_respond / negotiate_finalize / negotiate_list / negotiate_cancel for multi-turn scheduling coordination with another person or team.",
    "Do not use OWNER_CALENDAR for morning briefs, night briefs, operating pictures, command-center views, or broad day-start/day-end reviews. Those belong to RUN_MORNING_CHECKIN / RUN_NIGHT_CHECKIN even when they include meeting context.",
    "Set shouldAct=false only when this is not a calendar/scheduling request and another action should handle it.",
    "When shouldAct=false, response must be a short clarifying sentence in the user's language.",
    "",
    'Example: "need to book 1 hour per day for time with Jill, any time is fine, ideally before sleep" -> {"subaction":"recurring_block","shouldAct":true,"response":null}',
    'Example: "I\'m in Tokyo for limited time so let\'s schedule PendingReality and Ryan at the same time if possible" -> {"subaction":"propose_times","shouldAct":true,"response":null}',
    'Example: "flag the conflict before my flight later and help rebook the other thing" -> {"subaction":"travel_itinerary","shouldAct":true,"response":null}',
    'Example: "We\'re gonna cancel some stuff and push everything back until next month. All partnership meetings." -> {"subaction":"bulk_reschedule","shouldAct":true,"response":null}',
    "",
    `Current request: ${JSON.stringify(messageText(args.message))}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Structured parameters: ${JSON.stringify(args.params)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return { subaction: null, shouldAct: null };
    }
    const subaction = normalizeSubaction(parsed.subaction);
    return {
      subaction,
      shouldAct: subaction ? true : normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:owner-calendar",
        error: error instanceof Error ? error.message : String(error),
      },
      "Owner calendar planning model call failed",
    );
    return { subaction: null, shouldAct: null };
  }
}

async function route(
  subaction: OwnerCalendarSubaction,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const params = getParams(options);
  const { target, innerSubaction } = translateSubaction(subaction);
  const delegatedCallback: HandlerCallback | undefined = callback
    ? async (content, files) =>
        callback(
          content && typeof content === "object"
            ? { ...content, action: ACTION_NAME }
            : content,
          files,
        )
    : undefined;

  const forwardedOptions: HandlerOptions = {
    ...(options ?? {}),
    parameters: innerSubaction
      ? (({ ...params, subaction: innerSubaction } as unknown) as HandlerOptions["parameters"])
      : ((params as unknown) as HandlerOptions["parameters"]),
  };

  switch (target) {
    case "calendar":
      return (await calendarAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "bulk_reschedule":
      return handleBulkReschedulePreview({
        runtime,
        message,
        callback: delegatedCallback,
      });
    case "propose_times":
      return (await proposeMeetingTimesAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "check_availability":
      return (await checkAvailabilityAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "update_preferences":
      return (await updateMeetingPreferencesAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "calendly":
      return (await calendlyAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "scheduling":
      return (await schedulingAction.handler!(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
  }
}

export const ownerCalendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Legacy action names (for back-compat inbound routing).
    "CALENDAR_ACTION",
    "PROPOSE_MEETING_TIMES",
    "CHECK_AVAILABILITY",
    "UPDATE_MEETING_PREFERENCES",
    "SCHEDULING",
    "CALENDLY",
    // Natural synonyms.
    "CALENDAR",
    "SCHEDULE",
    "MEETING",
    "CHECK_CALENDAR",
    "SHOW_CALENDAR_TODAY",
    "WEEK_AHEAD",
    "WHATS_MY_NEXT_MEETING",
    "NEXT_MEETING",
    "SCHEDULE_EVENT",
    "CREATE_CALENDAR_EVENT",
    "SEARCH_CALENDAR",
    "ITINERARY",
    "TRAVEL_SCHEDULE",
    "CHECK_FLIGHT_CONFLICT",
    "FLIGHT_CONFLICT_REBOOKING",
    "REBOOK_CONFLICTING_EVENT",
    "BOOK_TIME_BLOCK",
    "RECURRING_TIME_BLOCK",
    "REBOOK_TRAVEL",
    "SUGGEST_MEETING_TIMES",
    "OFFER_MEETING_SLOTS",
    "FIND_MEETING_SLOTS",
    "PROPOSE_SLOTS",
    "BUNDLE_MEETINGS_WHILE_TRAVELING",
    "BULK_RESCHEDULE_MEETINGS",
    "PUSH_MEETINGS_NEXT_MONTH",
    "AM_I_FREE",
    "AVAILABILITY_CHECK",
    "FREE_BUSY",
    "SET_MEETING_PREFERENCES",
    "SAVE_MEETING_PREFERENCES",
    "SET_PREFERRED_TIMES",
    "SET_BLACKOUT_WINDOWS",
    "SLEEP_WINDOW",
    "NO_CALL_HOURS",
    "PROTECT_SLEEP",
    "NEGOTIATE_MEETING",
    "MULTI_TURN_SCHEDULING",
    "MANAGE_SCHEDULING_NEGOTIATION",
    "RESPOND_TO_MEETING_PROPOSAL",
    "FINALIZE_SCHEDULING_NEGOTIATION",
    "CALENDLY_LIST_EVENT_TYPES",
    "CALENDLY_AVAILABILITY",
    "CALENDLY_UPCOMING",
    "CALENDLY_BOOKING_LINK",
  ],
  tags: [
    "always-include",
    "calendar",
    "event",
    "recurring block",
    "time block",
    "daily time with Jill",
    "travel itinerary",
    "meeting slots",
    "bundle meetings while traveling",
    "bulk partnership reschedule",
    "push meetings to next month",
    "reschedule options",
    "sleep window",
    "no-call hours",
    "protected hours",
    "blackout window",
    "meeting preferences",
    "scheduling rules",
    "flight conflict",
    "rebook the other thing",
  ],
  description:
    "Owner's calendar and scheduling surface: Google Calendar (view, search, create, travel), " +
    "Calendly (event types, availability, upcoming, booking links), availability " +
    "checks, meeting-preference updates, and multi-turn scheduling negotiation. " +
    "This action owns concrete calendar and scheduling requests — route here instead of inventing " +
    "separate calendar/scheduling/calendly actions. " +
    "Subactions — Google Calendar: view_today, view_week, next_event, search_events, " +
    "create_event, travel_itinerary, recurring_block, bulk_reschedule. Availability: check_availability, " +
    "propose_times. Preferences: update_preferences. Calendly: calendly_availability, " +
    "calendly_list_event_types, calendly_upcoming, calendly_single_use_link. " +
    "Negotiation: negotiate_start, negotiate_propose, negotiate_respond, " +
    "negotiate_finalize, negotiate_list, negotiate_cancel. " +
    "Routing: default to Google Calendar for most view/create/search/travel " +
    "operations; when the request mentions Calendly by name or carries a " +
    "calendly.com / api.calendly.com URL (including eventTypeUri), use the " +
    "calendly_* subactions; 'help me schedule with <person>' / 'set up a meeting " +
    "with <person>' / 'find a time with <team>' with no concrete date → " +
    "negotiate_start; 'propose N times for <person>' / 'suggest a few slots' / " +
    "'offer three times' → propose_times; 'check if I'm free at <time>' / " +
    "'am I free tomorrow between 2 and 4' → check_availability; sleep windows, " +
    "no-call hours, blackout windows, preferred hours → update_preferences. " +
    "When the user is defining when meetings or calls may be scheduled, even in " +
    "a policy form like 'no calls between 11pm and 8am unless I explicitly say " +
    "it's okay', this action owns the preference. Do not hand those scheduling " +
    "rules to device reminder or phone-ring actions unless the user explicitly " +
    "means device alerts or ringing behavior. If the user is asking to remind " +
    "or bump them later about an unanswered decision rather than changing the " +
    "calendar itself, another action should own it. " +
    "Choose this action even when the owner has not supplied the exact time window yet, as long as the request is clearly calendar-owned. Recurring daily time blocks, travel-window meeting bundling, and flight-conflict rebooking all belong here and may ask the minimum follow-up inside the action. Do not stay in chat just because the exact flight time, booking reference, or conflicting event id is still missing. " +
    "Do NOT use this action for morning briefs, night briefs, operating pictures, command-center views, " +
    "or broad day-start/day-end reviews that combine inbox, calendar, and tasks — those belong to RUN_MORNING_CHECKIN / RUN_NIGHT_CHECKIN. " +
    "This action provides the final grounded reply; do not pair it with a " +
    "speculative REPLY action.",
  descriptionCompressed:
    "Owner calendar umbrella: Google Calendar + Calendly + availability + meeting preferences + negotiation, routed via `subaction`.",
  suppressPostActionContinuation: true,
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Union of old validators: negotiation + calendly require admin, calendar +
    // scheduling-lite require lifeops access. The umbrella gates on either —
    // the per-target handler re-checks its own stricter access before acting.
    if (await hasLifeOpsAccess(runtime, message)) return true;
    if (await hasAdminAccess(runtime, message)) return true;
    return false;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const params = getParams(options);
    const subaction = normalizeSubaction(params.subaction);
    if (!subaction) {
      const intent = (params.intent ?? messageText(message)).trim();
      const deterministicPlan = inferDeterministicOwnerCalendarPlan(intent);
      if (deterministicPlan) {
        const mergedOptions: HandlerOptions = {
          ...(options ?? {}),
          parameters: {
            ...params,
            ...(deterministicPlan.parameters ?? {}),
            subaction: deterministicPlan.subaction,
          } as HandlerOptions["parameters"],
        };
        return route(
          deterministicPlan.subaction,
          runtime,
          message,
          state,
          mergedOptions,
          callback,
        );
      }
      const plan = await resolveOwnerCalendarPlanWithLlm({
        runtime,
        message,
        state,
        intent,
        params,
      });
      if (plan.subaction) {
        return route(plan.subaction, runtime, message, state, options, callback);
      }
      const text =
        plan.response ??
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, adjust scheduling preferences, use Calendly, or manage a scheduling negotiation.";
      await callback?.({ text });
      return {
        text,
        success: true,
        data: { error: "MISSING_SUBACTION", noop: true },
      };
    }
    return route(subaction, runtime, message, state, options, callback);
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which calendar operation to run. Google Calendar: view_today, view_week, next_event, search_events, create_event, travel_itinerary, recurring_block, bulk_reschedule. Availability: check_availability, propose_times. Preferences: update_preferences. Calendly: calendly_availability, calendly_list_event_types, calendly_upcoming, calendly_single_use_link. Negotiation: negotiate_start, negotiate_propose, negotiate_respond, negotiate_finalize, negotiate_list, negotiate_cancel.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...VALID_SUBACTIONS],
      },
    },
    {
      name: "intent",
      description:
        'Natural-language description of the calendar request (e.g. "what is on my calendar today", "do i have any flights this week", "create a meeting tomorrow at 3pm").',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Event title when creating a calendar event.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Search phrase for search_events / travel_itinerary (e.g. flight, dentist, Denver).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional array of search phrases for search_events. Combined and deduped.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "details",
      description:
        "Structured calendar fields — time bounds, timezone, calendar id, create-event timing, location, and attendees.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "durationMinutes",
      description:
        "Meeting length in minutes. Used by propose_times and negotiate_start.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "daysAhead",
      description:
        "Days ahead for propose_times search window (defaults to 7, ignored when windowStart/windowEnd are supplied).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "slotCount",
      description: "Number of candidate slots for propose_times (defaults to 3).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "windowStart",
      description: "ISO-8601 earliest start of the propose_times search window.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "windowEnd",
      description: "ISO-8601 latest end of the propose_times search window.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "startAt",
      description:
        "ISO-8601 start time. Used by check_availability and negotiate_propose.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endAt",
      description:
        "ISO-8601 end time. Used by check_availability and negotiate_propose.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timeZone",
      description:
        "IANA time zone for update_preferences (interprets preferred hours).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "preferredStartLocal",
      description:
        "Earliest preferred meeting start time-of-day (local HH:MM, 24h).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "preferredEndLocal",
      description:
        "Latest preferred meeting end time-of-day (local HH:MM, 24h).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "defaultDurationMinutes",
      description: "Default meeting duration in minutes (5–480).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "travelBufferMinutes",
      description: "Minutes to reserve before/after each meeting (0–240).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "blackoutWindows",
      description:
        "Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun..6=Sat) }.",
      required: false,
      schema: { type: "array" as const },
    },
    {
      name: "negotiationId",
      description:
        "Target negotiation ID for negotiate_propose, negotiate_finalize, negotiate_cancel, or listing proposals.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "proposalId",
      description:
        "Target proposal ID for negotiate_respond or negotiate_finalize.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "subject",
      description: "Subject of the meeting (used by negotiate_start).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "response",
      description: "Proposal response: accepted, declined, or expired.",
      required: false,
      schema: { type: "string" as const, enum: ["accepted", "declined", "expired"] },
    },
    {
      name: "confirmed",
      description: "Set true alongside a proposalId to finalize a negotiation.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "relationshipId",
      description: "Optional relationship ID linked to a negotiation.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timezone",
      description:
        "Timezone for the scheduling negotiation / Calendly queries (distinct from the preferences `timeZone` field).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "proposedBy",
      description: "Who proposed the slot: agent, owner, or counterparty.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["agent", "owner", "counterparty"],
      },
    },
    {
      name: "reason",
      description: "Optional reason passed to negotiate_cancel.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "eventTypeUri",
      description:
        "Calendly event type URI. Required for calendly_availability and calendly_single_use_link.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "startDate",
      description:
        "ISO date (YYYY-MM-DD) for Calendly range queries (availability, upcoming).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endDate",
      description: "ISO date (YYYY-MM-DD) for Calendly range queries.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      { name: "{{name1}}", content: { text: "What's on my calendar today?" } },
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
        content: { text: "Am I free tomorrow between 2pm and 4pm?" },
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
        content: { text: "Propose three 30-minute slots for a sync with Marco next week." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are 3 options you can offer:\n1. Mon, Apr 27, 10:00 AM – 10:30 AM (30 min)\n2. Tue, Apr 28, 2:00 PM – 2:30 PM (30 min)\n3. Wed, Apr 29, 11:00 AM – 11:30 AM (30 min)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Help me schedule a quarterly review with Alice." },
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
        content: {
          text: "What's my Calendly availability next week for the 30 min meeting?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Calendly availability:\n- 2026-04-20: 4 slot(s) — ...",
        },
      },
    ],
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
          text: "Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll set up a recurring daily one-hour block with Jill and keep it biased toward the evening before your sleep window.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I'm in Tokyo for limited time so let's schedule PendingReality and Ryan at the same time if possible.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll look for Tokyo-time options that bundle PendingReality and Ryan into the same window and flag the best slots.",
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
          text: "I'll check the flight conflict, surface the conflicting event, and hold any rebooking behind your approval.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "We're gonna cancel some stuff and push everything back until next month. All partnership meetings.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll scope the partnership meetings affected and queue the bulk reschedule for your approval before anything is sent.",
        },
      },
    ],
  ] as ActionExample[][],
};
