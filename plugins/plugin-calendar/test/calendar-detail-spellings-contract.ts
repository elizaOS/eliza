/**
 * Calendar tools accept several historical spellings of a `details` field, and
 * tool-argument validation runs before the handler folds them into one. This
 * is that contract for one registration of the Calendar family, run against
 * both the standalone plugin's and the personal assistant's: every spelling
 * keeps passing validation, while the definition the planner reads describes a
 * field once, on the spelling it should write. A described alternate costs
 * its text again on every request that offers the tool and reads as one more
 * field to fill.
 *
 * The spellings are written out, not derived from the schema source, so that
 * dropping one from the schema fails here instead of silently narrowing
 * validation.
 */
import {
  type Action,
  buildPlannerToolsFromActions,
  validateToolArgs,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

interface DetailField {
  /** Accepted spellings; the first is the one the planner is told to write. */
  spellings: readonly string[];
  /** A value every tool's schema for this field accepts. */
  value: unknown;
  /** Field the handler folds the spellings into, when not the first spelling. */
  handlerField?: string;
}

export const DETAIL_FIELDS = {
  clearFields: { spellings: ["clearFields"], value: ["location"] },
  calendarId: {
    spellings: ["calendarId", "calendarid", "calendar_id"],
    value: "primary",
  },
  endDate: { spellings: ["endDate"], value: "2026-10-29" },
  timeMin: {
    spellings: ["timeMin", "timemin", "time_min"],
    value: "2026-10-28T09:00:00",
  },
  timeMax: {
    spellings: ["timeMax", "timemax", "time_max"],
    value: "2026-10-28T17:00:00",
  },
  timeZone: {
    spellings: ["timeZone", "timezone", "time_zone"],
    value: "America/Los_Angeles",
  },
  windowPreset: {
    spellings: ["windowPreset", "windowpreset", "window_preset"],
    value: "tomorrow",
  },
  eventId: {
    spellings: [
      "eventId",
      "eventid",
      "event_id",
      "externaleventid",
      "external_event_id",
      "googleeventid",
      "google_event_id",
    ],
    value: "evt_7f3a",
  },
  start: {
    spellings: [
      "start",
      "startAt",
      "startat",
      "start_at",
      "start_time",
      "startTime",
      "starttime",
    ],
    value: "2026-10-28T15:00:00",
    handlerField: "startAt",
  },
  end: {
    spellings: [
      "end",
      "endAt",
      "endat",
      "end_at",
      "end_time",
      "endTime",
      "endtime",
    ],
    value: "2026-10-28T16:00:00",
    handlerField: "endAt",
  },
  newTitle: {
    spellings: ["newTitle", "newtitle", "new_title", "renameto", "rename_to"],
    value: "Design review",
  },
  oldTitle: {
    spellings: ["oldTitle", "oldtitle", "old_title"],
    value: "Weekly sync",
  },
  title: { spellings: ["title"], value: "Weekly sync" },
  date: { spellings: ["date"], value: "2026-10-28" },
  query: { spellings: ["query"], value: "dentist" },
  label: { spellings: ["label"], value: "this week" },
  description: {
    spellings: ["description", "desc", "summary", "body"],
    value: "Bring the signed forms.",
  },
  location: {
    spellings: ["location", "place", "venue"],
    value: "12 Harbour Street",
  },
  mode: { spellings: ["mode"], value: "local" },
  side: { spellings: ["side"], value: "owner" },
  grantId: { spellings: ["grantId"], value: "grant_41c2" },
  recurrenceScope: {
    spellings: [
      "recurrenceScope",
      "recurrencescope",
      "recurrence_scope",
      "applyto",
      "apply_to",
      "editscope",
      "edit_scope",
    ],
    value: "series",
  },
  travelOriginAddress: {
    spellings: [
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
    ],
    value: "40 Mill Lane",
  },
  durationMinutes: {
    spellings: ["durationMinutes", "durationminutes", "duration_minutes"],
    value: 45,
  },
  windowDays: {
    spellings: ["windowDays", "windowdays", "window_days"],
    value: 3,
  },
  forceSync: {
    spellings: ["forceSync", "forcesync", "force_sync"],
    value: true,
  },
  notifyAttendees: { spellings: ["notifyAttendees"], value: false },
  allowPast: { spellings: ["allowPast"], value: true },
  allDay: { spellings: ["allDay"], value: true },
  confirmed: { spellings: ["confirmed"], value: true },
  includeHiddenCalendars: {
    spellings: ["includeHiddenCalendars"],
    value: true,
  },
  recurrence: {
    spellings: [
      "recurrence",
      "rrule",
      "recurrencerule",
      "recurrence_rule",
      "repeat",
      "repeats",
      "repeatrule",
      "repeat_rule",
    ],
    value: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  },
  queries: { spellings: ["queries"], value: ["dentist", "orthodontist"] },
  sourceNote: {
    spellings: ["sourceNote"],
    value: {
      agentId: "agent-1",
      noteId: "note-1",
      contentHash: "a".repeat(64),
    },
  },
  attendees: { spellings: ["attendees"], value: ["sam@example.com"] },
} satisfies Record<string, DetailField>;

export type DetailFieldName = keyof typeof DETAIL_FIELDS;

const EVERY_FIELD = Object.keys(DETAIL_FIELDS) as DetailFieldName[];
const READ_FIELDS = [
  "date",
  "endDate",
  "calendarId",
  "timeMin",
  "timeMax",
  "timeZone",
  "forceSync",
  "windowDays",
  "label",
  "mode",
  "side",
  "grantId",
  "includeHiddenCalendars",
] as const satisfies readonly DetailFieldName[];

/**
 * The fields each tool's `details` takes. Creation has always taken the
 * planner's spelling alone; every other tool takes every spelling.
 */
const TOOL_DETAIL_FIELDS: Record<
  string,
  { fields: readonly DetailFieldName[]; everySpelling: boolean }
> = {
  CALENDAR: { fields: EVERY_FIELD, everySpelling: true },
  CALENDAR_UPDATE_EVENT: { fields: EVERY_FIELD, everySpelling: true },
  CALENDAR_DELETE_EVENT: { fields: EVERY_FIELD, everySpelling: true },
  CALENDAR_TRIP_WINDOW: { fields: EVERY_FIELD, everySpelling: true },
  CALENDAR_FEED: { fields: READ_FIELDS, everySpelling: true },
  CALENDAR_SEARCH_EVENTS: {
    fields: [...READ_FIELDS, "query", "queries", "oldTitle"],
    everySpelling: true,
  },
  CALENDAR_NEXT_EVENT: {
    fields: ["calendarId", "timeZone"],
    everySpelling: true,
  },
  CALENDAR_CREATE_EVENT: {
    fields: [
      "calendarId",
      "timeZone",
      "start",
      "end",
      "durationMinutes",
      "windowPreset",
      "description",
      "location",
      "mode",
      "side",
      "grantId",
      "travelOriginAddress",
      "allowPast",
      "allDay",
      "notifyAttendees",
      "recurrence",
      "attendees",
      "sourceNote",
    ],
    everySpelling: false,
  },
};

function acceptedSpellings(tool: string): string[] {
  const { fields, everySpelling } = TOOL_DETAIL_FIELDS[tool];
  return fields.flatMap((field) => {
    const { spellings } = DETAIL_FIELDS[field];
    return everySpelling ? spellings : spellings.slice(0, 1);
  });
}

/** Read windows take one representation, so a bound is valid only beside its partner. */
const PARTNERS: Partial<Record<DetailFieldName, DetailFieldName>> = {
  timeMin: "timeMax",
  timeMax: "timeMin",
  endDate: "date",
};

/** Arguments the tool's validation accepts, carrying one field under one spelling. */
function argumentsWith(
  action: Action,
  field: DetailFieldName,
  spelling: string,
): Record<string, unknown> {
  const partner = PARTNERS[field];
  return {
    // Only what the tool requires, so the spelling under test decides validity.
    ...Object.fromEntries(
      (action.parameters ?? [])
        .filter((parameter) => parameter.required)
        .map((parameter) => [
          parameter.name,
          parameter.schema.enum?.[0] ?? "Weekly sync",
        ]),
    ),
    details: {
      ...(partner ? { [partner]: DETAIL_FIELDS[partner].value } : {}),
      [spelling]: DETAIL_FIELDS[field].value,
    },
  };
}

type DetailsLevel = {
  properties?: Record<string, { description?: string }>;
};

/** Each object the planner sees for `details`: one, or one per read window. */
export function plannerDetailLevels(action: Action): DetailsLevel[] {
  const [tool] = buildPlannerToolsFromActions([action]);
  const details = (
    tool.parameters as {
      properties?: Record<string, DetailsLevel & { oneOf?: DetailsLevel[] }>;
    }
  ).properties?.details;
  if (!details) throw new Error(`${action.name} declares no details`);
  return details.oneOf ?? [details];
}

export function describeCalendarDetailSpellings(
  registered: readonly Action[],
): void {
  const tools = Object.keys(TOOL_DETAIL_FIELDS).map((name) => {
    const action = registered.find((candidate) => candidate.name === name);
    if (!action) throw new Error(`${name} is not registered`);
    return { name, action };
  });

  describe.each(tools)("$name details", ({ name, action }) => {
    const { fields } = TOOL_DETAIL_FIELDS[name];

    it("passes tool-argument validation under every accepted spelling", () => {
      for (const field of fields)
        for (const spelling of DETAIL_FIELDS[field].spellings.slice(
          0,
          TOOL_DETAIL_FIELDS[name].everySpelling ? undefined : 1,
        ))
          expect(
            validateToolArgs(action, argumentsWith(action, field, spelling)),
            `${field} as ${spelling}`,
          ).toMatchObject({ valid: true });
    });

    it("declares the accepted spellings and no others", () => {
      const declared = new Set(
        plannerDetailLevels(action).flatMap((level) =>
          Object.keys(level.properties ?? {}),
        ),
      );
      expect([...declared].sort()).toEqual(acceptedSpellings(name).sort());
      expect(
        validateToolArgs(action, {
          ...argumentsWith(action, "calendarId", "calendarId"),
          details: { calendarID: "primary" },
        }).valid,
      ).toBe(false);
    });

    it("describes a field on the planner's spelling only", () => {
      for (const level of plannerDetailLevels(action))
        for (const field of fields)
          for (const alternate of DETAIL_FIELDS[field].spellings.slice(1))
            expect(
              level.properties?.[alternate]?.description,
              `${alternate} repeats ${field}`,
            ).toBeUndefined();
    });
  });
}
