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
      CALENDAR_DETAIL_STRING_KEYS.map((key) => [key, stringSchema]),
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
