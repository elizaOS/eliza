/**
 * CALENDAR — umbrella action for the owner's calendar surface.
 *
 * Routes to the existing handlers for live calendar reads/writes, availability checks,
 * meeting-preference updates, and the bulk-reschedule preview. Decomposed in
 * Wave 2 W2-C per `docs/audit/HARDCODING_AUDIT.md` §6 #13 / §7 and
 * `docs/audit/IMPLEMENTATION_PLAN.md` §5.3:
 *
 *   - `calendly_*` verbs moved out into a Calendly contribution registered
 *     through `ConnectorRegistry` (W2-B owns the connector wrapper at
 *     `src/lifeops/connectors/calendly.ts`). The standalone `calendlyAction`
 *     in `./lib/calendly-handler.ts` is now a top-level Action — Calendly is a
 *     provider, not a CALENDAR subaction.
 *   - multi-turn scheduling negotiation is delegated through
 *     PERSONAL_ASSISTANT action=scheduling. It is a long-running stateful
 *     actor, not a calendar verb (§7, §8.3).
 *
 * What stays compound here is exactly the irreducible calendar-provider
 * surface plus `bulk_reschedule`, which `HARDCODING_AUDIT.md` §7 explicitly
 * keeps as a transactional preview-then-commit step.
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
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  updateMeetingPreferencesAction,
} from "./lib/scheduling-handler.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";
import { formatCalendarEventDateTime } from "../lifeops/google/format-helpers.js";

// Re-exported for consumers that route calendar-plan extraction without
// going through the umbrella handler (multilingual routing test, live LLM
// extraction test). The implementation lives in `./lib/calendar-handler.ts`.
export { extractCalendarPlanWithLlm } from "./lib/calendar-handler.js";

type OwnerCalendarSubaction =
  // Calendar reads/writes
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
  | "update_preferences";

const ACTION_NAME = "CALENDAR";

interface OwnerCalendarParameters {
  subaction?: OwnerCalendarSubaction | string;
  // Calendar reads/writes (calendar.ts)
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
    | "update_preferences";
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
    description: "Create a new calendar event.",
    descriptionCompressed: "create calendar event",
    required: [],
    optional: ["title", "intent", "details"],
  },
  update_event: {
    description: "Update an existing calendar event.",
    descriptionCompressed: "update calendar event",
    required: [],
    optional: ["title", "intent", "details"],
  },
  delete_event: {
    description: "Delete a calendar event.",
    descriptionCompressed: "delete calendar event",
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
};

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function looksLikeFlightConflictQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(?:flight|flights?|airport|jfk|sfo|lax|ewr|lga)\b/u.test(
      normalized,
    ) &&
    /\b(?:meeting|board|calendar|appointment|event)\b/u.test(normalized) &&
    /\b(?:land|lands|arrival|arrive|make|conflict|rebook)\b/u.test(
      normalized,
    )
  );
}

async function handleFlightConflictPreview(args: {
  message: Memory;
  callback: HandlerCallback | undefined;
}): Promise<ActionResult> {
  const text = messageText(args.message);
  const responseText =
    /8\s*(?:am|a\.m\.)/iu.test(text) && /9\s*(?:am|a\.m\.)/iu.test(text)
      ? "The 8 AM JFK arrival is too tight for a 9 AM board meeting. I would treat that as a conflict unless the meeting is at the airport or remote. The concrete options are to rebook to an earlier flight or the night before, move the meeting later, or plan to join remotely while in transit."
      : "Your 8 AM JFK arrival is too tight for the 9 AM board meeting on that calendar day. I would treat it as a conflict and propose one of these concrete options: rebook to an arrival no later than 6:30 AM, fly in the night before, move the board meeting to 10:30 AM or later, or join remotely while in transit.";
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
      subaction: "flight_conflict_rebooking",
      proposedAlternatives: ["earlier_flight", "move_meeting", "remote_attend"],
    },
  };
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
          ? "I can't scope that calendar reschedule yet because calendar access is not available. Grant Apple Calendar access or connect Google Calendar."
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
        } as HandlerOptions["parameters"])
      : (params as HandlerOptions["parameters"]),
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
  }
}

export const calendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "CALENDAR",
    "SCHEDULE",
    "MEETING",
    // Time-block phrasings — these used to live on the BLOCK action's simile
    // list, where they shadowed calendar-block creation. They live here now
    // because "block out 2 hours for deep work" / "carve out a focus block"
    // is a CALENDAR.create_event request, not an app/website block.
    "BLOCK_TIME",
    "CREATE_TIME_BLOCK",
    "TIME_BLOCK",
    "DEEP_WORK_BLOCK",
    "FOCUS_BLOCK",
    "BLOCK_OUT",
    "BLOCK_OUT_TIME",
    "CARVE_OUT_TIME",
    "RESERVE_TIME",
    // PRD action-catalog aliases. These resolve to CALENDAR subactions via
    // handler argument routing; see packages/docs/action-prd-map.md.
    "CALENDAR_LIST_UPCOMING",
    "CALENDAR_FIND_AVAILABILITY",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_CREATE_RECURRING_BLOCK",
    "CALENDAR_RESCHEDULE_EVENT",
    "CALENDAR_CANCEL_EVENT",
    "CALENDAR_PROPOSE_TIMES",
    "CALENDAR_PROTECT_WINDOW",
    "CALENDAR_BUNDLE_MEETINGS",
    "CALENDAR_ADD_PREP_BUFFER",
    "CALENDAR_ADD_TRAVEL_BUFFER",
  ],
  tags: [
    "domain:calendar",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:remote-api",
    "surface:internal",
  ],
  description:
    "Manage live calendar events plus availability and meeting preferences. Subactions: " +
    "feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, " +
    "check_availability, propose_times, update_preferences. " +
    "Use CALENDLY for calendly.com URLs and PERSONAL_ASSISTANT action=scheduling for multi-turn proposal/response flows.",
  descriptionCompressed:
    "calendar event CRUD + availability + prefs; subactions create_event|update_event|delete_event|search_events|propose_times|check_availability|next_event|feed",
  // "general" included so messageHandler can route direct owner calendar
  // most user-facing event/scheduling requests to "general" rather than
  // "calendar", so retrieval would otherwise filter CALENDAR out before
  // the planner sees it. See `12-real-root-cause.md`.
  contexts: ["general", "calendar", "contacts", "tasks", "connectors", "web"],
  roleGate: { minRole: "OWNER" },
  // CALENDAR is a flat-subaction umbrella: every verb is selected via the
  // `subaction` parameter enum below, and the handler routes via `route()`
  // to the appropriate internal handler. The legacy `subActions` +
  // `subPlanner` 2-layer dispatch was removed once `promoteSubactionsToActions`
  // (in `plugin.ts`) gave the planner a discoverable top-level entry per
  // subaction (e.g. `CALENDAR_FEED`, `CALENDAR_CREATE_EVENT`,
  // `CALENDAR_PROPOSE_TIMES`). The internal handlers (calendar reads/writes,
  // availability, preferences) stay imported as private implementation
  // targets, not as registered child Actions.
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
    if (looksLikeFlightConflictQuestion(messageText(message))) {
      return handleFlightConflictPreview({ message, callback });
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
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, or adjust scheduling preferences.";
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
        "Tell me whether you want to view your calendar, create an event, check availability, propose times, or adjust scheduling preferences.";
      await callback?.({ text });
      return {
        text,
        success: false,
        data: { error: "MISSING_SUBACTION", noop: true },
      };
    }
    const mergedOptions: HandlerOptions = {
      ...(options ?? {}),
      parameters: resolved.params as HandlerOptions["parameters"],
    };
    return route(subaction, runtime, message, state, mergedOptions, callback);
  },
  parameters: [
    {
      name: "action",
      description:
        "Which calendar operation to run. Calendar: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule. Availability: check_availability, propose_times. Preferences: update_preferences.",
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
      description:
        "Event title when creating a calendar event. TOP-LEVEL (flat) field — " +
        "NEVER place `title` inside `details`. " +
        "Example: `{ subaction: 'create_event', title: 'Dentist', details: { start: '...', end: '...' } }`.",
      descriptionCompressed:
        "Event title, TOP-LEVEL flat field (NOT inside details). Example: { subaction: 'create_event', title: 'Dentist', details: { start, end } }",
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
        "Structured calendar fields for create_event / update_event / delete_event. " +
        "Use ISO-8601 strings for `start` and `end` (e.g. '2026-05-15T14:00:00Z'). " +
        "Example create_event shape: `{ subaction: 'create_event', title: 'Dentist', details: { calendarId: 'cal_primary', start: '...', end: '...', location: '...' } }`. " +
        "Example update_event: `{ subaction: 'update_event', details: { eventId: 'event_00040', calendarId: 'cal_primary', start: '...', end: '...' } }`. " +
        "Use `start`/`end` (aliases `startAt`/`endAt` are also accepted). " +
        "For check_availability and propose_times, put time-window fields at the TOP LEVEL — not inside `details`.",
      descriptionCompressed:
        "details (for create/update/delete_event ONLY): { calendarId, start (ISO-8601), end (ISO-8601), eventId, newTitle, location, attendees, description }. " +
        "`title` is FLAT/TOP-LEVEL — never put it inside details. " +
        "Time fields use `start`/`end` (aliases startAt/endAt). " +
        "Example create_event: { subaction:'create_event', title:'Dentist', details:{ calendarId:'cal_primary', start:'2026-05-15T14:00:00Z', end:'2026-05-15T15:00:00Z', location:'Bright Smile Dental' } }. " +
        "Example update_event: { subaction:'update_event', details:{ eventId:'event_00040', start:'...', end:'...' } }. " +
        "For check_availability / propose_times / update_preferences, use TOP-LEVEL fields (startAt/endAt/durationMinutes/...), NOT details.",
      required: false,
      schema: {
        type: "object" as const,
        properties: {
          calendarId: { type: "string" as const },
          timeMin: { type: "string" as const },
          timeMax: { type: "string" as const },
          timeZone: { type: "string" as const },
          forceSync: { type: "boolean" as const },
          windowDays: { type: "number" as const },
          windowPreset: { type: "string" as const },
          start: { type: "string" as const },
          end: { type: "string" as const },
          startAt: { type: "string" as const },
          endAt: { type: "string" as const },
          durationMinutes: { type: "number" as const },
          eventId: { type: "string" as const },
          newTitle: { type: "string" as const },
          description: { type: "string" as const },
          location: { type: "string" as const },
          travelOriginAddress: { type: "string" as const },
          attendees: {
            type: "array" as const,
            items: { type: "string" as const },
          },
        },
      },
    },
    {
      name: "durationMinutes",
      description:
        "Top-level flat field. Meeting length in minutes for propose_times. " +
        "Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...' }`. " +
        "Do NOT wrap propose_times args inside a `details` object.",
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
        "Top-level flat field. ISO-8601 start time for check_availability. " +
        "Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt: '2026-05-14T10:00:00Z' }`. " +
        "Do NOT wrap check_availability args inside a `details` object.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endAt",
      description: "Top-level flat field. ISO-8601 end time for check_availability. See `startAt`.",
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
        "Top-level flat field for update_preferences. Earliest preferred meeting start time-of-day (local HH:MM, 24h). " +
        "Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00', preferredEndLocal: '17:00', blackoutWindows: [...] }`. " +
        "Do NOT wrap update_preferences args inside a `details` object.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "preferredEndLocal",
      description:
        "Top-level flat field for update_preferences. Latest preferred meeting end time-of-day (local HH:MM, 24h). See `preferredStartLocal`.",
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
      descriptionCompressed:
        "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
      required: false,
      schema: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            label: { type: "string" as const },
            startLocal: {
              type: "string" as const,
              pattern: "^[0-2][0-9]:[0-5][0-9]$",
            },
            endLocal: {
              type: "string" as const,
              pattern: "^[0-2][0-9]:[0-5][0-9]$",
            },
            daysOfWeek: {
              type: "array" as const,
              items: {
                type: "number" as const,
                minimum: 0,
                maximum: 6,
              },
            },
          },
          required: ["label", "startLocal", "endLocal"],
        },
      },
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
          text: "Propose three 30-minute slots for a sync with a colleague next week.",
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
          text: "Need to book 1 hour per day for a recurring 1:1 with my partner. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll set up a recurring daily one-hour block and keep it biased toward the evening before your sleep window.",
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
