/**
 * CALENDAR — umbrella action for the owner's calendar surface.
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
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import {
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../lifeops/time.js";
import { calendarAction as googleCalendarAction } from "./lib/calendar-handler.js";
import { calendlyAction } from "./lib/calendly-handler.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./lib/scheduling-handler.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";
import { formatCalendarEventDateTime } from "../lifeops/google/format-helpers.js";

type OwnerCalendarSubaction =
  // Google Calendar
  | "feed"
  | "next_event"
  | "search_events"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "trip_window"
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
  | "negotiate_list_active"
  | "negotiate_list_proposals"
  | "negotiate_cancel";

const ACTION_NAME = "CALENDAR";

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

function getParams(
  options: HandlerOptions | undefined,
): OwnerCalendarParameters {
  return ((options?.parameters as OwnerCalendarParameters | undefined) ??
    {}) as OwnerCalendarParameters;
}

/**
 * Translate an umbrella `subaction` into the inner sub-route that each target
 * action expects. We pass through the rest of `parameters` unchanged so every
 * handler reads its own inputs.
 */
function translateSubaction(subaction: OwnerCalendarSubaction): {
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
    case "feed":
      return { target: "calendar", innerSubaction: "feed" };
    case "next_event":
      return { target: "calendar", innerSubaction: "next_event" };
    case "search_events":
      return { target: "calendar", innerSubaction: "search_events" };
    case "create_event":
      return { target: "calendar", innerSubaction: "create_event" };
    case "update_event":
      return { target: "calendar", innerSubaction: "update_event" };
    case "delete_event":
      return { target: "calendar", innerSubaction: "delete_event" };
    case "trip_window":
      return { target: "calendar", innerSubaction: "trip_window" };
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
    case "negotiate_list_active":
      return { target: "scheduling", innerSubaction: "list_active" };
    case "negotiate_list_proposals":
      return { target: "scheduling", innerSubaction: "list_proposals" };
    case "negotiate_cancel":
      return { target: "scheduling", innerSubaction: "cancel" };
  }
}

const VALID_SUBACTIONS: readonly OwnerCalendarSubaction[] = [
  "feed",
  "next_event",
  "search_events",
  "create_event",
  "update_event",
  "delete_event",
  "trip_window",
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
  "negotiate_list_active",
  "negotiate_list_proposals",
  "negotiate_cancel",
];

function normalizeSubaction(value: unknown): OwnerCalendarSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerCalendarSubaction)
    : null;
}

const OWNER_CALENDAR_SUBACTION_SPECS: SubactionsMap<OwnerCalendarSubaction> = {
  feed: {
    description:
      "List calendar events over a time window (today, this week, etc).",
    descriptionCompressed: "list events time-window",
    required: [],
    optional: ["intent", "details"],
  },
  next_event: {
    description: "Show the single next upcoming event.",
    descriptionCompressed: "next upcoming event",
    required: [],
    optional: ["intent", "details"],
  },
  search_events: {
    description:
      "Search calendar events by title, attendee, location, or date.",
    descriptionCompressed: "search events title|attendee|location|date",
    required: [],
    optional: ["intent", "query", "queries", "details"],
  },
  create_event: {
    description: "Create a new Google Calendar event.",
    descriptionCompressed: "create gcal event",
    required: [],
    optional: ["title", "intent", "details"],
  },
  update_event: {
    description: "Update an existing Google Calendar event.",
    descriptionCompressed: "update gcal event",
    required: [],
    optional: ["title", "intent", "details"],
  },
  delete_event: {
    description: "Delete a Google Calendar event.",
    descriptionCompressed: "delete gcal event",
    required: [],
    optional: ["intent", "details"],
  },
  trip_window: {
    description: "List events occurring during a trip or while in a place.",
    descriptionCompressed: "events trip-window place",
    required: [],
    optional: ["intent", "query", "details"],
  },
  bulk_reschedule: {
    description: "Preview a cohort of meetings to push into a future window.",
    descriptionCompressed: "preview bulk reschedule cohort future-window",
    required: [],
    optional: ["timeZone", "intent"],
  },
  check_availability: {
    description: "Check whether the owner is free in an ISO start/end window.",
    descriptionCompressed: "check free|busy ISO-window",
    required: [],
    optional: ["startAt", "endAt", "intent"],
  },
  propose_times: {
    description: "Propose candidate meeting slots within a window.",
    descriptionCompressed: "propose candidate meeting slots window",
    required: [],
    optional: [
      "durationMinutes",
      "daysAhead",
      "slotCount",
      "windowStart",
      "windowEnd",
      "counterparties",
      "timeZone",
    ],
  },
  update_preferences: {
    description:
      "Update meeting preferences (preferred hours, blackouts, travel buffer).",
    descriptionCompressed: "update meeting prefs hours blackouts travel-buffer",
    required: [],
    optional: [
      "timeZone",
      "preferredStartLocal",
      "preferredEndLocal",
      "defaultDurationMinutes",
      "travelBufferMinutes",
      "blackoutWindows",
    ],
  },
  calendly_list_event_types: {
    description: "List Calendly event types.",
    descriptionCompressed: "list calendly event-types",
    required: [],
    optional: [],
  },
  calendly_availability: {
    description: "Check Calendly availability for an event type URI.",
    descriptionCompressed: "calendly availability event-type-uri",
    required: ["eventTypeUri"],
    optional: ["startDate", "endDate", "timezone"],
  },
  calendly_upcoming: {
    description: "List upcoming Calendly-scheduled events.",
    descriptionCompressed: "upcoming calendly events",
    required: [],
    optional: ["startDate", "endDate"],
  },
  calendly_single_use_link: {
    description: "Generate a single-use Calendly booking link.",
    descriptionCompressed: "calendly single-use booking link",
    required: ["eventTypeUri"],
    optional: [],
  },
  negotiate_start: {
    description: "Start a multi-turn scheduling negotiation.",
    descriptionCompressed: "start multi-turn scheduling negotiation",
    required: [],
    optional: [
      "subject",
      "durationMinutes",
      "counterparties",
      "relationshipId",
      "timezone",
    ],
  },
  negotiate_propose: {
    description: "Propose a slot in an active scheduling negotiation.",
    descriptionCompressed: "propose slot active negotiation",
    required: ["negotiationId"],
    optional: ["startAt", "endAt", "proposedBy"],
  },
  negotiate_respond: {
    description: "Respond to a scheduling proposal.",
    descriptionCompressed: "respond scheduling proposal accept|decline|expire",
    required: ["proposalId", "response"],
    optional: ["negotiationId"],
  },
  negotiate_finalize: {
    description: "Finalize a scheduling negotiation by confirming a proposal.",
    descriptionCompressed: "finalize negotiation confirm proposal",
    required: ["proposalId"],
    optional: ["negotiationId", "confirmed"],
  },
  negotiate_cancel: {
    description: "Cancel an active scheduling negotiation.",
    descriptionCompressed: "cancel active negotiation",
    required: ["negotiationId"],
    optional: ["reason"],
  },
  negotiate_list_active: {
    description: "List active scheduling negotiations.",
    descriptionCompressed: "list active negotiations",
    required: [],
    optional: [],
  },
  negotiate_list_proposals: {
    description: "List proposals on a single scheduling negotiation.",
    descriptionCompressed: "list proposals negotiation",
    required: ["subaction", "negotiationId"],
    optional: [],
  },
};

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
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

function buildBulkRescheduleLookupWindow(
  timeZone: string,
  text: string,
): {
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

  const fortyFiveDaysOut = new Date(
    startOfToday.getTime() + 45 * 24 * 60 * 60_000,
  );
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
  timeZone: string | null;
}): Promise<ActionResult> {
  const text = messageText(args.message);
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();
  const cohortLabel = extractBulkRescheduleCohortLabel(text);
  const { timeMin, timeMax, scopeLabel } = buildBulkRescheduleLookupWindow(
    timeZone,
    text,
  );
  const service = new LifeOpsService(args.runtime);

  let events: readonly LifeOpsCalendarEvent[] = [];
  try {
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      includeHiddenCalendars: true,
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
      ? ({
          ...params,
          subaction: innerSubaction,
        } as unknown as HandlerOptions["parameters"])
      : (params as unknown as HandlerOptions["parameters"]),
  };

  switch (target) {
    case "calendar":
      return (await googleCalendarAction.handler?.(
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
        timeZone: params.timeZone ?? null,
      });
    case "propose_times":
      return (await proposeMeetingTimesAction.handler?.(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "check_availability":
      return (await checkAvailabilityAction.handler?.(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "update_preferences":
      return (await updateMeetingPreferencesAction.handler?.(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "calendly":
      return (await calendlyAction.handler?.(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
    case "scheduling":
      return (await schedulingAction.handler?.(
        runtime,
        message,
        state,
        forwardedOptions,
        delegatedCallback,
      )) as ActionResult;
  }
}

export const calendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: ["CALENDAR", "SCHEDULE", "MEETING"],
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
    "Owner's calendar and scheduling surface: Google Calendar (view feed, search, create/update/delete events, trip windows, bulk reschedule), " +
    "Calendly (event types, availability, upcoming, single-use booking links), availability checks, meeting-preference updates, " +
    "and multi-turn scheduling negotiation. Subactions: feed, next_event, search_events, create_event, update_event, delete_event, " +
    "trip_window, bulk_reschedule, propose_times, check_availability, update_preferences, " +
    "calendly_list_event_types, calendly_availability, calendly_upcoming, calendly_single_use_link, " +
    "negotiate_start, negotiate_propose, negotiate_respond, negotiate_finalize, negotiate_cancel, " +
    "negotiate_list_active, negotiate_list_proposals.",
  descriptionCompressed:
    "calendar+calendly+availability+prefs+negotiation: feed next-event search create update delete trip-window bulk-reschedule propose-times check-availability update-prefs calendly-(list-event-types availability upcoming single-use-link) negotiate-(start propose respond finalize cancel list-active list-proposals)",
  contexts: ["calendar", "contacts", "tasks", "connectors", "web"],
  roleGate: { minRole: "OWNER" },
  subActions: [
    googleCalendarAction,
    proposeMeetingTimesAction,
    checkAvailabilityAction,
    updateMeetingPreferencesAction,
    calendlyAction,
    schedulingAction,
  ],
  subPlanner: {
    name: "calendar_subplanner",
    description:
      "Explodes calendar, Calendly, availability, preferences, and scheduling negotiation sub-actions for multi-step calendar work.",
  },
  suppressPostActionContinuation: true,
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return hasLifeOpsAccess(runtime, message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Calendar actions are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const resolved = await resolveActionArgs<
      OwnerCalendarSubaction,
      OwnerCalendarParameters
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: OWNER_CALENDAR_SUBACTION_SPECS,
    });
    if (!resolved.ok) {
      const text =
        resolved.clarification ||
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, adjust scheduling preferences, use Calendly, or manage a scheduling negotiation.";
      await callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "MISSING_SUBACTION",
          missing: resolved.missing,
          noop: true,
        },
      };
    }
    const subaction = normalizeSubaction(resolved.subaction);
    if (!subaction) {
      const text =
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, adjust scheduling preferences, use Calendly, or manage a scheduling negotiation.";
      await callback?.({ text });
      return {
        text,
        success: false,
        data: { error: "MISSING_SUBACTION", noop: true },
      };
    }
    const mergedOptions: HandlerOptions = {
      ...(options ?? {}),
      parameters: resolved.params as unknown as HandlerOptions["parameters"],
    };
    return route(subaction, runtime, message, state, mergedOptions, callback);
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which calendar operation to run. Google Calendar: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule. Availability: check_availability, propose_times. Preferences: update_preferences. Calendly: calendly_list_event_types, calendly_availability, calendly_upcoming, calendly_single_use_link. Negotiation: negotiate_start, negotiate_propose, negotiate_respond, negotiate_finalize, negotiate_cancel, negotiate_list_active, negotiate_list_proposals.",
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
      description:
        "Number of candidate slots for propose_times (defaults to 3).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "windowStart",
      description:
        "ISO-8601 earliest start of the propose_times search window.",
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
      schema: {
        type: "string" as const,
        enum: ["accepted", "declined", "expired"],
      },
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
        content: {
          text: "Propose three 30-minute slots for a sync with Marco next week.",
        },
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
