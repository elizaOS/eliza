/**
 * Planner-visible server capabilities for the Calendar view. Each declaration
 * maps one-to-one onto `view-interact.ts`, the server-side control plane that
 * executes against `CalendarService` without requiring a mounted renderer —
 * the same contract the Notes view establishes with its capability set.
 *
 * Scope is deliberately honest: `create-event` writes only to the agent's
 * built-in Eliza calendar (always writable, no external account required).
 * Connected provider calendars (Google/Microsoft/Apple) take mutations through
 * the chat `CALENDAR` action's approval gateway, never through this surface.
 */

import type { ViewCapability, ViewCapabilityParameter } from "@elizaos/core";

const TIME_ZONE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    'Optional IANA time zone (e.g. "America/Los_Angeles"). Defaults to the agent\'s calendar time zone.',
  minLength: 1,
  maxLength: 64,
};

const DATE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    'Calendar date "YYYY-MM-DD" in the time zone. Defaults to today.',
  minLength: 8,
  maxLength: 10,
  pattern: "^\\d{4}-\\d{1,2}-\\d{1,2}$",
};

const DAYS_PARAM: ViewCapabilityParameter = {
  type: "integer",
  description: "Number of days to include starting at the date. Defaults to 1.",
  minimum: 1,
  maximum: 31,
};

const TITLE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Event title exactly as the user stated it.",
  required: true,
  minLength: 1,
  maxLength: 300,
  pattern: "\\S",
};

const START_AT_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    'Event start as local wall time "YYYY-MM-DDTHH:MM" in the time zone, or an ISO-8601 instant with offset.',
  required: true,
  minLength: 10,
  maxLength: 40,
  pattern: "^\\d{4}-\\d{1,2}-\\d{1,2}([T ]\\d{1,2}:\\d{2}.*)?$",
};

const END_AT_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    "Optional event end in the same format as startAt. Defaults to startAt plus durationMinutes.",
  minLength: 10,
  maxLength: 40,
  pattern: "^\\d{4}-\\d{1,2}-\\d{1,2}([T ]\\d{1,2}:\\d{2}.*)?$",
};

const DURATION_MINUTES_PARAM: ViewCapabilityParameter = {
  type: "integer",
  description: "Optional event length in minutes. Defaults to 60.",
  minimum: 1,
  maximum: 24 * 60,
};

const LOCATION_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Optional event location.",
  minLength: 1,
  maxLength: 500,
};

const DESCRIPTION_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Optional event description or notes.",
  minLength: 1,
  maxLength: 4000,
};

export const CALENDAR_VIEW_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-events",
    description:
      "List calendar events for a day or short range as structured data from the unified feed (built-in plus connected Google, Microsoft, Apple, and ICS calendars).",
    params: {
      date: DATE_PARAM,
      days: DAYS_PARAM,
      timeZone: TIME_ZONE_PARAM,
    },
  },
  {
    id: "create-event",
    description:
      "Create a one-off calendar event with a title and start time on the agent's built-in calendar (always available; no external account needed). Booking on a connected Google, Microsoft, or Apple calendar instead goes through the chat approval flow, not this capability.",
    params: {
      title: TITLE_PARAM,
      startAt: START_AT_PARAM,
      endAt: END_AT_PARAM,
      durationMinutes: DURATION_MINUTES_PARAM,
      timeZone: TIME_ZONE_PARAM,
      location: LOCATION_PARAM,
      description: DESCRIPTION_PARAM,
    },
  },
];
