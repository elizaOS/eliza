/** Operation-specific authored read metadata; the fixed canonical handlers stay unchanged. */
import {
  type Action,
  type ActionParameter,
  type ActionParameterSchema,
  promotedSubactionDescription,
  promoteSubactionsToActions,
} from "@elizaos/core";
import {
  CALENDAR_CREATE_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_DETAIL_ALIASES,
  CALENDAR_FEED_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_NEXT_EVENT_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_SEARCH_DETAILS_PARAMETER_SCHEMA,
} from "./calendar-action-schema.js";
import { calendarReadPromptProjection } from "./calendar-read-result.js";
export function calendarReadParameters(
  parent: Action,
  operation: "feed" | "next_event" | "search_events",
): readonly ActionParameter[] {
  const names = new Set([
    "subaction",
    "intent",
    "details",
    "grantId",
    "calendarId",
    ...(operation === "search_events" ? ["query", "queries"] : []),
  ]);
  const sourceDetails =
    operation === "feed"
      ? CALENDAR_FEED_DETAILS_PARAMETER_SCHEMA
      : operation === "next_event"
        ? CALENDAR_NEXT_EVENT_DETAILS_PARAMETER_SCHEMA
        : CALENDAR_SEARCH_DETAILS_PARAMETER_SCHEMA;
  const aliases = new Set<string>(
    Object.values(CALENDAR_DETAIL_ALIASES).flat(),
  );
  const descriptions: Record<string, string> = {
    calendarId: "Exact Calendar result ID.",
    grantId: "Exact connected grant ID; pair with calendarId.",
    timeZone:
      operation === "next_event"
        ? "IANA timezone; default owner zone."
        : "IANA timezone for this request. Resolve relative dates from CURRENT_TIME local date in this zone, never its UTC instant date.",
    includeHiddenCalendars:
      operation === "search_events"
        ? "Default includes hidden calendars; false restricts to selected calendars."
        : "Default selected calendars only; true only when user requests hidden/all.",
    forceSync: "Refresh selected source before read.",
    windowDays: "Next local days, at most 90.",
    windowPreset: "Existing named calendar read window.",
    mode: "Exact connector deployment mode from source.",
    side: "Exact connector ownership side from source.",
    label: "Read window label.",
    query: "User-supplied event content filter.",
    queries: "Additional user-supplied content filters.",
    oldTitle: "Legacy event-content query.",
  };
  // Old callers retain all spellings at the unchanged normalizer. The planner
  // exposes one canonical spelling per semantic field, never mutation fields.
  const details = {
    ...sourceDetails,
    properties: Object.fromEntries(
      Object.entries(sourceDetails.properties ?? {})
        .filter(([key]) => !aliases.has(key))
        .map(([key, value]) => [
          key,
          (() => {
            const { description: _redundant, ...schema } = value;
            return {
              ...schema,
              ...(["date", "endDate", "timeMin", "timeMax"].includes(key) &&
              _redundant
                ? { description: _redundant }
                : {}),
              ...([
                "date",
                "endDate",
                "timeMin",
                "timeMax",
                "timeZone",
                "includeHiddenCalendars",
                "windowDays",
              ].includes(key) && descriptions[key]
                ? { description: descriptions[key] }
                : {}),
            };
          })(),
        ]),
    ),
  };
  // The planner must choose one window representation. These are metadata
  // branches only; canonical/legacy handler normalization and day guards stay intact.
  const windowKeys = [
    "date",
    "endDate",
    "timeMin",
    "timeMax",
    "windowDays",
    "windowPreset",
  ];
  const common = Object.fromEntries(
    Object.entries(details.properties).filter(
      ([key]) => !windowKeys.includes(key),
    ),
  );
  const branch = (
    keys: string[],
    required: string[],
  ): ActionParameterSchema => ({
    type: "object",
    properties: {
      ...common,
      ...Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(details.properties, key))
          .map((key) => [key, details.properties[key]]),
      ),
    },
    required,
    additionalProperties: false,
  });
  const windows = [
    { keys: ["date", "endDate"], required: ["date"] },
    { keys: ["timeMin", "timeMax"], required: ["timeMin", "timeMax"] },
    { keys: ["windowDays"], required: ["windowDays"] },
    { keys: ["windowPreset"], required: ["windowPreset"] },
    { keys: [], required: [] },
  ];
  // Each operation's canonical schema owns its supported window forms.
  // Never materialize an absent optional field or a branch requiring one.
  const readDetails: ActionParameterSchema =
    operation === "next_event"
      ? details
      : {
          oneOf: windows
            .filter(({ required }) =>
              required.every((key) => Object.hasOwn(details.properties, key)),
            )
            .map(({ keys, required }) => branch(keys, required)),
        };
  return (parent.parameters ?? [])
    .filter((parameter) => names.has(parameter.name))
    .map((parameter) => {
      if (parameter.name === "details")
        return {
          ...parameter,
          description:
            operation === "next_event"
              ? "Next-event source and timezone."
              : "Read window/source: date/endDate OR timeMin/timeMax with timeZone.",
          schema: readDetails,
        };
      if (parameter.name === "intent")
        return { ...parameter, description: "User’s calendar read request." };
      if (parameter.name === "grantId")
        return {
          ...parameter,
          description:
            "Exact grantId+calendarId from CALENDAR_SOURCES; omit for local.",
        };
      if (parameter.name === "calendarId")
        return {
          ...parameter,
          description: "Exact calendarId paired with grantId.",
        };
      if (parameter.name === "query")
        return {
          ...parameter,
          required: operation === "search_events",
          schema: { ...parameter.schema, type: "string", minLength: 1 },
          description:
            "Required event-content filter from the current user request or its resolved referent, such as the existing event title. Dates/source/account names alone are not content filters; dates go in details. Omit this operation for an unfiltered agenda.",
        };
      if (parameter.name === "queries")
        return { ...parameter, description: "Additional content filters." };
      return parameter;
    });
}

/** One canonical operation family, generated from the existing parent enum.
 * Read metadata narrows reads only; write children retain the parent handler,
 * authority, provider selection and durable outcome receipts. */
export function calendarOperationActions(
  calendarAction: Action,
): readonly Action[] {
  const calendarReadOverrides = {
    feed: {
      parameters: calendarReadParameters(calendarAction, "feed"),
      description:
        "Read the full unfiltered agenda within the requested date/time range. A bounded agenda is not a single-next-event lookup; use CALENDAR_NEXT_EVENT for that. Calendar/account/source selection is not an event-content filter. No mutation.",
    },
    next_event: {
      parameters: calendarReadParameters(calendarAction, "next_event"),
      description:
        "Find the single nearest ongoing or upcoming calendar event relative to now, including across dates. Use for the next event, meeting or appointment when no event-content filter is requested. A named provider, account or calendar selects the source; it does not make this an event search. No mutation.",
    },
    search_events: {
      parameters: calendarReadParameters(calendarAction, "search_events"),
      description:
        "Search events by a user-supplied event title, attendee, location or topic, optionally within date/time bounds. A provider/account/calendar name selects the source, not a content query. For a single next event without a content filter use CALENDAR_NEXT_EVENT; for an unfiltered agenda use CALENDAR_FEED. No mutation.",
    },
  };
  return promoteSubactionsToActions(calendarAction, {
    overrides: {
      ...calendarReadOverrides,
      create_event: {
        parameters: calendarCreateParameters(calendarAction),
        description:
          "Create one event in the canonical Calendar service at the user-authorized time/source. The service already reads fresh authorized Calendar context before interpreting the original request and checking the destination and conflicts. Relative timing such as after an existing event may be resolved from that context; do not invent its clock time or require a separate read solely because the request is relative. Use a separate search when the reference still needs discovery. Original-request creation extraction and fresh conflict/source checks still run before any write.",
      },
    },
  }).map((action) => {
    const operation = promotedSubactionDescription(action)?.subaction;
    if (!operation || !Object.hasOwn(calendarReadOverrides, operation))
      return action;
    return {
      ...action,
      async handler(...args: Parameters<NonNullable<typeof action.handler>>) {
        const result = await action.handler!(...args);
        return result
          ? { ...result, ...calendarReadPromptProjection(result.data) }
          : result;
      },
    };
  });
}

/** Canonical creation spelling; the umbrella retains all legacy aliases.
 * Generated fields are hints, never a bypass of original-request extraction. */
export function calendarCreateParameters(
  parent: Action,
): readonly ActionParameter[] {
  const names = new Set([
    "subaction",
    "intent",
    "title",
    "details",
    "grantId",
    "calendarId",
  ]);
  return (parent.parameters ?? [])
    .filter((parameter) => names.has(parameter.name))
    .map((parameter) => {
      if (parameter.name === "details")
        return {
          ...parameter,
          schema: CALENDAR_CREATE_DETAILS_PARAMETER_SCHEMA,
          description:
            "Proposed event fields: start, optional end or durationMinutes, and timeZone, plus only requested description/location/attendees/recurrence. One canonical spelling per field. These are hints; the service re-derives authorization and scheduling from the original request and current Calendar evidence.",
        };
      if (parameter.name === "intent")
        return {
          ...parameter,
          description:
            "Current authorized creation request, preserving its time/source constraints and resolved referents. Do not substitute an unrelated earlier edit.",
        };
      if (parameter.name === "title")
        return {
          ...parameter,
          description:
            "Exact requested title of the NEW event, not the existing event used to resolve a relative time.",
        };
      return parameter;
    });
}
