/**
 * OWNER_CALENDAR — umbrella action for the owner's calendar surface.
 *
 * Routes to the existing handlers for Google Calendar, Calendly, availability
 * checks, meeting-preference updates, and multi-turn scheduling negotiation
 * based on a planner-provided `subaction` string. The umbrella is a thin
 * router: it never re-implements any handler logic, it never performs
 * regex-based intent inference, and it trusts the planner's `subaction`.
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
import { hasAdminAccess } from "@elizaos/agent/security";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import { calendarAction } from "./calendar.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./scheduling.js";
import { calendlyAction } from "./calendly.js";

type OwnerCalendarSubaction =
  // Google Calendar
  | "view_today"
  | "view_week"
  | "next_event"
  | "search_events"
  | "create_event"
  | "travel_itinerary"
  | "recurring_block"
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
    "Choose check_availability for free/busy questions over a specific window.",
    "Choose propose_times for requests to suggest or offer a few candidate meeting slots.",
    "Choose update_preferences for durable rules like no-call hours, blackout windows, preferred hours, sleep windows, and travel buffer.",
    "Requests that define when meetings or calls may happen, even if phrased as a standing policy like 'no calls between 11pm and 8am unless I explicitly say it's okay', are update_preferences.",
    "Do not use OWNER_CALENDAR for reminder-only or bump-me-later policies about unanswered event decisions; those belong to reminder, inbox, or escalation actions instead.",
    "Do not use OWNER_CALENDAR for device ringing, push-notification, or cross-device reminder behavior. Those belong to device-intent actions.",
    "Choose calendly_availability / calendly_list_event_types / calendly_upcoming / calendly_single_use_link when the request mentions Calendly by name or includes a calendly.com URL or eventTypeUri.",
    "Choose negotiate_start / negotiate_propose / negotiate_respond / negotiate_finalize / negotiate_list / negotiate_cancel for multi-turn scheduling coordination with another person or team.",
    "Do not use OWNER_CALENDAR for morning briefs, night briefs, operating pictures, command-center views, or broad day-start/day-end reviews. Those belong to RUN_MORNING_CHECKIN / RUN_NIGHT_CHECKIN even when they include meeting context.",
    "Set shouldAct=false only when this is not a calendar/scheduling request and another action should handle it.",
    "When shouldAct=false, response must be a short clarifying sentence in the user's language.",
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
    "BOOK_TIME_BLOCK",
    "RECURRING_TIME_BLOCK",
    "REBOOK_TRAVEL",
    "SUGGEST_MEETING_TIMES",
    "OFFER_MEETING_SLOTS",
    "FIND_MEETING_SLOTS",
    "PROPOSE_SLOTS",
    "BUNDLE_MEETINGS_WHILE_TRAVELING",
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
    "travel itinerary",
    "meeting slots",
    "reschedule options",
    "sleep window",
    "no-call hours",
    "protected hours",
    "blackout window",
    "meeting preferences",
    "scheduling rules",
  ],
  description:
    "Owner's calendar and scheduling surface: Google Calendar (view, search, create, travel), " +
    "Calendly (event types, availability, upcoming, booking links), availability " +
    "checks, meeting-preference updates, and multi-turn scheduling negotiation. " +
    "This action owns concrete calendar and scheduling requests — route here instead of inventing " +
    "separate calendar/scheduling/calendly actions. " +
    "Subactions — Google Calendar: view_today, view_week, next_event, search_events, " +
    "create_event, travel_itinerary, recurring_block. Availability: check_availability, " +
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
        "Which calendar operation to run. Google Calendar: view_today, view_week, next_event, search_events, create_event, travel_itinerary, recurring_block. Availability: check_availability, propose_times. Preferences: update_preferences. Calendly: calendly_availability, calendly_list_event_types, calendly_upcoming, calendly_single_use_link. Negotiation: negotiate_start, negotiate_propose, negotiate_respond, negotiate_finalize, negotiate_list, negotiate_cancel.",
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
  ] as ActionExample[][],
};
