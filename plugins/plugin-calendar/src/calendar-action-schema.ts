/**
 * Leaf metadata for CALENDAR's nested planner arguments. Both the calendar
 * action and its PA host wrapper import this module directly so action-schema
 * construction cannot depend on either plugin's runtime registration cycle.
 */

import type { ActionParameterSchema } from "@elizaos/core";

const CALENDAR_DETAIL_STRING_KEYS = [
  "calendarId",
  "calendarid",
  "calendar_id",
  "timeMin",
  "timemin",
  "time_min",
  "timeMax",
  "timemax",
  "time_max",
  "timeZone",
  "timezone",
  "time_zone",
  "windowPreset",
  "windowpreset",
  "window_preset",
  "eventId",
  "eventid",
  "event_id",
  "externaleventid",
  "external_event_id",
  "googleeventid",
  "google_event_id",
  "startAt",
  "startat",
  "start_at",
  "start",
  "start_time",
  "starttime",
  "endAt",
  "endat",
  "end_at",
  "end",
  "end_time",
  "endtime",
  "newTitle",
  "newtitle",
  "new_title",
  "renameto",
  "rename_to",
  "oldTitle",
  "oldtitle",
  "old_title",
  "title",
  "query",
  "label",
  "description",
  "desc",
  "summary",
  "body",
  "location",
  "place",
  "venue",
  "mode",
  "side",
  "grantId",
  "recurrenceScope",
  "recurrencescope",
  "recurrence_scope",
  "applyto",
  "apply_to",
  "editscope",
  "edit_scope",
  "travelOriginAddress",
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
] as const;

const CALENDAR_DETAIL_NUMBER_KEYS = [
  "durationMinutes",
  "durationminutes",
  "duration_minutes",
  "windowDays",
  "windowdays",
  "window_days",
] as const;

const CALENDAR_DETAIL_BOOLEAN_KEYS = [
  "forceSync",
  "forcesync",
  "force_sync",
  "notifyAttendees",
] as const;

const CALENDAR_DETAIL_RECURRENCE_KEYS = [
  "recurrence",
  "rrule",
  "recurrencerule",
  "recurrence_rule",
  "repeat",
  "repeats",
  "repeatrule",
  "repeat_rule",
] as const;

const stringSchema: ActionParameterSchema = { type: "string" };
// Planner-facing guidance for the timestamp leaves. Live 2026-09-05 the
// planner rendered "tuesday at 7am" as "2026-09-08T07:00:00Z" (a fabricated
// UTC instant) and day bounds as "2026-09-08T00:00:00Z".."23:59:59Z" for a
// Pacific owner; the runtime applies the owner's zone to offset-less values.
const LOCAL_WALL_TIME_FORMAT =
  "the user's local wall-clock time formatted YYYY-MM-DDTHH:mm:ss with NO trailing Z and NO UTC offset (the runtime applies the user's timezone); never convert to UTC";
const CALENDAR_DETAIL_STRING_DESCRIPTIONS: Partial<
  Record<(typeof CALENDAR_DETAIL_STRING_KEYS)[number], string>
> = {
  startAt: `Event start as ${LOCAL_WALL_TIME_FORMAT}.`,
  start: `Event start as ${LOCAL_WALL_TIME_FORMAT}.`,
  endAt:
    "Event end in the same local wall-clock format as startAt; omit it to use durationMinutes.",
  end: "Event end in the same local wall-clock format as start; omit it to use durationMinutes.",
  timeMin: `Window start as ${LOCAL_WALL_TIME_FORMAT}, or RFC 3339 with an explicit numeric offset.`,
  timeMax: "Window end (exclusive) in the same format as timeMin.",
  timeZone:
    "IANA timezone only when the user names one (e.g. America/New_York); otherwise omit it so the user's configured timezone applies.",
};
const numberSchema: ActionParameterSchema = { type: "number" };
const booleanSchema: ActionParameterSchema = { type: "boolean" };
// The runtime normalizer (internal/recurrence.ts) accepts a single RRULE
// string or an array of RFC 5545 lines, so the schema offers both branches.
// `anyOf` rather than `oneOf`: strict-mode provider grammars (Cerebras)
// reject `oneOf`, and a sibling `type` would contradict the array branch.
const recurrenceSchema: ActionParameterSchema = {
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
};

export const CALENDAR_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema = {
  type: "object",
  properties: {
    ...Object.fromEntries(
      CALENDAR_DETAIL_STRING_KEYS.map((key) => {
        const description = CALENDAR_DETAIL_STRING_DESCRIPTIONS[key];
        return [
          key,
          description ? { ...stringSchema, description } : stringSchema,
        ];
      }),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_NUMBER_KEYS.map((key) => [key, numberSchema]),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_BOOLEAN_KEYS.map((key) => [key, booleanSchema]),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_RECURRENCE_KEYS.map((key) => [key, recurrenceSchema]),
    ),
    queries: {
      type: "array",
      items: { type: "string" },
    },
    attendees: {
      type: "array",
      items: {
        type: "object",
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              email: { type: "string" },
              displayName: { type: "string" },
              optional: { type: "boolean" },
            },
            required: ["email"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  additionalProperties: false,
};
