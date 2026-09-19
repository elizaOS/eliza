/**
 * Exercises the real planner-to-provider schema boundary. Calendar's operation
 * union must not turn absent travel fields (or their aliases) into required
 * strings that the planner has to invent just to satisfy the wire grammar.
 */
import type { Action, ActionParameterSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../packages/core/src/actions/promote-subactions.js";
import { buildPlannerToolsFromActions } from "../../../packages/core/src/actions/to-tool.js";
import {
  validateSchema,
  validateToolArgs,
} from "../../../packages/core/src/actions/validate-tool-args.js";
import { createCalendarActionRunner } from "../../plugin-calendar/src/actions/calendar-handler.js";
import { __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall } from "../../plugin-openai/models/text.js";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../src/actions/calendar.js";
import { resolveCreateEventTravelIntent } from "../src/travel-time/calendar-create.js";

const domainCalendarAction = createCalendarActionRunner({
  runTextModel: async () => null,
  runJsonModel: async () => null,
  recentConversationTexts: async () => [],
});

it("keeps create arguments canonical while preserving the legacy umbrella and event capabilities", () => {
  const create = promoteSubactionsToActions(
    calendarAction,
    calendarActionPromotionOptions,
  ).find((action) => action.name === "CALENDAR_CREATE_EVENT");
  if (!create) throw new Error("Missing create action");
  const tools = normalizeNativeToolsForCall(
    buildPlannerToolsFromActions([create]),
    { cerebrasMode: true },
  ).tools;
  if (!tools) throw new Error("Missing native tools");
  const schema = (
    tools[create.name] as { inputSchema: { jsonSchema: ActionParameterSchema } }
  ).inputSchema.jsonSchema;
  const input = {
    title: "Workshop",
    details: {
      start: "2026-09-21T10:00:00",
      end: "2026-09-21T11:00:00",
      timeZone: "America/Los_Angeles",
      calendarId: "selected-calendar",
      grantId: "selected-grant",
      side: "owner",
      description: "Bring the drawings.",
      location: "Studio",
      travelOriginAddress: "Office",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      attendees: [
        { email: "guest@example.com", displayName: "Guest", optional: true },
      ],
      notifyAttendees: true,
    },
  };
  const errors: string[] = [];
  validateSchema(schema, input, "", errors);
  expect(errors).toEqual([]);
  expect(validateToolArgs(create, input)).toMatchObject({
    valid: true,
    args: input,
  });
  for (const details of [
    { oldTitle: "Coffee" },
    { end_time: "2026-09-21T11:00:00" },
    { queries: ["coffee"] },
  ]) {
    const invalidErrors: string[] = [];
    validateSchema(schema, { title: "Workshop", details }, "", invalidErrors);
    expect(invalidErrors.length).toBeGreaterThan(0);
    expect(validateToolArgs(create, { title: "Workshop", details }).valid).toBe(
      false,
    );
    expect(
      validateToolArgs(calendarAction, { title: "Workshop", details }).valid,
    ).toBe(true);
  }
});

describe.each([
  ["personal-assistant calendar", calendarAction],
  ["domain calendar", domainCalendarAction],
] as const)("%s optional native arguments", (_name, parent) => {
  it.each([false, true])(
    "admits sparse calendar creates through the provider schema without weakening travel types (Cerebras: %s)",
    (cerebrasMode) => {
      const family = promoteSubactionsToActions(
        parent,
        parent === calendarAction ? calendarActionPromotionOptions : {},
      );
      expect(family.length).toBeGreaterThan(1);
      const create = family.find(
        (action) => action.name === "CALENDAR_CREATE_EVENT",
      );
      if (!create)
        throw new Error("calendar create operation was not promoted");
      const normalized = normalizeNativeToolsForCall(
        buildPlannerToolsFromActions(family),
        { cerebrasMode },
      ).tools;
      if (!normalized)
        throw new Error("calendar tool family was not normalized");
      const tool = normalized[create.name] as {
        strict?: boolean;
        inputSchema: { jsonSchema: ActionParameterSchema };
      };
      expect(tool.strict).toBe(cerebrasMode);
      const args = {
        title: "Pottery class",
        details: {
          start: "2026-09-11T16:00:00.000Z",
          end: "2026-09-11T17:00:00.000Z",
          timeZone: "UTC",
        },
      };
      for (const details of [
        args.details,
        { ...args.details, travelOriginAddress: "Studio" },
      ]) {
        const input = { ...args, details };
        const errors: string[] = [];
        validateSchema(tool.inputSchema.jsonSchema, input, "", errors);
        expect(errors).toEqual([]);
        expect(validateToolArgs(create, input)).toMatchObject({
          valid: true,
          args: input,
        });
      }
      const invalid = {
        ...args,
        details: { ...args.details, travelOriginAddress: false },
      };
      const errors: string[] = [];
      validateSchema(tool.inputSchema.jsonSchema, invalid, "", errors);
      expect(errors.length).toBeGreaterThan(0);
      expect(validateToolArgs(create, invalid).valid).toBe(false);
    },
  );

  it("accepts a typed title on the promoted delete child", () => {
    // Live 2026-09-05 23:32: CALENDAR_DELETE_EVENT rejected a top-level title
    // ("Unexpected argument 'title'") that the parent accepts, so a valid
    // structured delete failed before any lookup and the turn ended with a
    // false failure reply.
    const del = promoteSubactionsToActions(parent).find(
      (action) => action.name === "CALENDAR_DELETE_EVENT",
    ) as Action;
    expect(del).toBeDefined();
    const args = {
      title: "Pottery class",
      details: { date: "2026-09-05", timeZone: "UTC" },
    };
    expect(validateToolArgs(del, args)).toMatchObject({ valid: true, args });
  });

  it("accepts a sparse create call but still rejects invalid typed travel arguments", () => {
    const create = promoteSubactionsToActions(parent).find(
      (action) => action.name === "CALENDAR_CREATE_EVENT",
    ) as Action;
    expect(create).toBeDefined();
    const args = {
      title: "Unknown",
      details: {
        start: "2026-07-27T16:00:00.000Z",
        end: "2026-07-27T17:00:00.000Z",
        timeZone: "UTC",
      },
    };
    expect(validateToolArgs(create, args)).toMatchObject({ valid: true, args });
    expect(
      resolveCreateEventTravelIntent({
        details: args.details,
        extractedDetails: {},
      }),
    ).toBeNull();
    for (const literal of [
      "Unknown",
      "None",
      "n/a",
      "traveloriginaddress_missing",
    ]) {
      expect(
        resolveCreateEventTravelIntent({
          details: { ...args.details, travelOriginAddress: literal },
          extractedDetails: {},
        }),
      ).toEqual({ originAddress: literal });
    }
    expect(
      validateToolArgs(create, {
        ...args,
        details: { ...args.details, travelOriginAddress: false },
      }).valid,
    ).toBe(false);
  });
});

it("retains every calendar and timezone spelling for next-event reads and the complete parent contract", () => {
  const family = promoteSubactionsToActions(
    calendarAction,
    calendarActionPromotionOptions,
  );
  const next = family.find((action) => action.name === "CALENDAR_NEXT_EVENT");
  if (!next) throw new Error("Missing next-event action");
  for (const calendarKey of ["calendarId", "calendarid", "calendar_id"]) {
    for (const timezoneKey of ["timeZone", "timezone", "time_zone"]) {
      const args = {
        details: {
          [calendarKey]: "cal_actual",
          [timezoneKey]: "America/New_York",
        },
      };
      expect(validateToolArgs(next, args)).toMatchObject({ valid: true, args });
    }
  }
  expect(validateToolArgs(next, {}).valid).toBe(true);
  expect(validateToolArgs(next, { details: { timeZone: 7 } }).valid).toBe(
    false,
  );
  const readSchema = next.parameters?.find(
    (parameter) => parameter.name === "details",
  )?.schema;
  const parentSchema = family[0].parameters?.find(
    (parameter) => parameter.name === "details",
  )?.schema;
  expect(parentSchema?.properties?.recurrence).toBeDefined();
  expect(readSchema?.properties?.recurrence).toBeUndefined();
  expect(next.roleGate).toEqual(calendarAction.roleGate);
  expect(next.disclosureGate).toEqual(calendarAction.disclosureGate);
});

it("requires a search query on the native wire and rejects empty text locally", () => {
  const family = promoteSubactionsToActions(
    calendarAction,
    calendarActionPromotionOptions,
  );
  const read = family.find(
    (action) => action.name === "CALENDAR_SEARCH_EVENTS",
  );
  if (!read) throw new Error("Missing search action");
  // Strict provider grammars omit minLength; the local validator retains it.
  expect(validateToolArgs(read, { query: "" }).valid).toBe(false);
  for (const cerebrasMode of [false, true]) {
    const normalized = normalizeNativeToolsForCall(
      buildPlannerToolsFromActions([read]),
      { cerebrasMode },
    ).tools;
    if (!normalized) throw new Error("Missing normalized tools");
    const schema = (
      normalized[read.name] as {
        inputSchema: { jsonSchema: ActionParameterSchema };
      }
    ).inputSchema.jsonSchema;
    for (const args of [
      {},
      {
        query: "Shaw",
        details: { date: "2026-09-20", timeZone: "America/New_York" },
      },
    ]) {
      const errors: string[] = [];
      validateSchema(schema, args, "", errors);
      expect(errors.length === 0).toBe(args.query === "Shaw");
      expect(validateToolArgs(read, args).valid).toBe(args.query === "Shaw");
    }
  }
});

it.each(["feed", "search_events"])(
  "preserves %s read scope, range and aliases without mutation details",
  (operation) => {
    const family = promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    );
    const read = family.find(
      (action) => action.name === `CALENDAR_${operation.toUpperCase()}`,
    );
    if (!read) throw new Error("Missing read action");
    const filter = operation === "search_events" ? { query: "Dentist" } : {};
    for (const suffix of [0, 1, 2]) {
      const details = {
        [["calendarId", "calendarid", "calendar_id"][suffix]]: "primary",
        [["timeMin", "timemin", "time_min"][suffix]]:
          "2026-09-13T00:00:00-04:00",
        [["timeMax", "timemax", "time_max"][suffix]]:
          "2026-09-14T00:00:00-04:00",
        [["timeZone", "timezone", "time_zone"][suffix]]: "America/New_York",
        [["forceSync", "forcesync", "force_sync"][suffix]]: true,
        [["windowDays", "windowdays", "window_days"][suffix]]: 60,
        mode: "local",
        side: "owner",
        grantId: "eliza-calendar",
        includeHiddenCalendars: false,
        label: "requested day",
      };
      expect(validateToolArgs(read, { ...filter, details })).toMatchObject({
        valid: true,
        args: { ...filter, details },
      });
    }
    expect(
      validateToolArgs(read, {
        ...filter,
        details: {
          date: "2026-09-18",
          endDate: "2026-09-20",
          timeZone: "America/New_York",
        },
      }).valid,
    ).toBe(true);
    expect(validateToolArgs(read, {}).valid).toBe(operation === "feed");
    expect(
      validateToolArgs(read, {
        ...filter,
        details: { includeHiddenCalendars: "true" },
      }).valid,
    ).toBe(false);
    expect(read.roleGate).toEqual(calendarAction.roleGate);
    expect(read.disclosureGate).toEqual(calendarAction.disclosureGate);
    const full = calendarAction.parameters?.find(
      (parameter) => parameter.name === "details",
    )?.schema;
    for (const action of family.filter((action) =>
      [
        "CALENDAR",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
        "CALENDAR_TRIP_WINDOW",
      ].includes(action.name),
    )) {
      expect(
        action.parameters?.find((parameter) => parameter.name === "details")
          ?.schema,
      ).toEqual(full);
    }
    if (operation === "search_events") {
      for (const key of ["query", "oldTitle", "oldtitle", "old_title"]) {
        expect(
          validateToolArgs(read, { ...filter, details: { [key]: "Dentist" } })
            .valid,
        ).toBe(true);
      }
      expect(
        validateToolArgs(read, {
          query: "Dentist",
          queries: ["Dentist"],
          details: { queries: ["Dentist"] },
        }).valid,
      ).toBe(true);
    }
  },
);

it.each(["feed", "search_events"])(
  "%s connector scope exposes only accepted modes and sides on the native wire",
  (operation) => {
    const family = promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    );
    const read = family.find(
      (action) => action.name === `CALENDAR_${operation.toUpperCase()}`,
    );
    if (!read) throw new Error("Missing read action");
    const filter = operation === "search_events" ? { query: "Dentist" } : {};
    const normalized = normalizeNativeToolsForCall(
      buildPlannerToolsFromActions([read]),
      { cerebrasMode: true },
    ).tools;
    if (!normalized) throw new Error("Missing normalized tools");
    const schema = (
      normalized[read.name] as {
        inputSchema: { jsonSchema: ActionParameterSchema };
      }
    ).inputSchema.jsonSchema;
    const errorsFor = (input: Record<string, unknown>) => {
      const errors: string[] = [];
      validateSchema(schema, input, "", errors);
      return errors;
    };
    for (const mode of ["local", "remote", "cloud_managed"]) {
      for (const side of ["owner", "agent"]) {
        expect(errorsFor({ ...filter, details: { mode, side } })).toEqual([]);
      }
    }
    for (const details of [
      { mode: "count" },
      { mode: "read" },
      { side: "all" },
    ]) {
      expect(errorsFor({ ...filter, details }).length).toBeGreaterThan(0);
    }
    expect(errorsFor(filter)).toEqual([]);
    // Parent compatibility remains separate from the promoted read grammar.
    expect(
      validateToolArgs(calendarAction, { details: { mode: "count" } }).valid,
    ).toBe(true);
  },
);

it.each([false, true])(
  "requires an explicit proposal window and duration at the native tool boundary (Cerebras %s)",
  (cerebrasMode) => {
    const action = promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    ).find((entry) => entry.name === "CALENDAR_PROPOSE_TIMES");
    if (!action) throw new Error("Missing proposal action");
    const tools = normalizeNativeToolsForCall(
      buildPlannerToolsFromActions([action]),
      { cerebrasMode },
    ).tools;
    if (!tools) throw new Error("Missing native proposal tool");
    const tool = tools[action.name] as {
      inputSchema: { jsonSchema: ActionParameterSchema };
    };
    expect(validateToolArgs(action, {}).valid).toBe(false);
    const args = {
      duration: { minutes: 15 },
      windowStart: "2026-09-18T08:00:00-04:00",
      windowEnd: "2026-09-18T12:00:00-04:00",
    };
    expect(validateToolArgs(action, args).valid).toBe(true);
    for (const duration of [
      { minutes: 15 },
      { existingEventQuery: "Team meeting" },
      { minutes: 30, existingEventQuery: "Team meeting" },
    ]) {
      const errors: string[] = [];
      validateSchema(
        tool.inputSchema.jsonSchema,
        { ...args, duration },
        "",
        errors,
      );
      expect(errors).toEqual([]);
    }
    expect(
      validateToolArgs(action, {
        ...args,
        duration: { existingEventQuery: "Team meeting" },
      }).valid,
    ).toBe(true);
    expect(validateToolArgs(action, { ...args, duration: {} }).valid).toBe(
      false,
    );
    expect(
      validateToolArgs(action, { ...args, duration: { minutes: 0 } }).valid,
    ).toBe(false);
    for (const key of Object.keys(args)) {
      const missing = { ...args } as Record<string, unknown>;
      delete missing[key];
      expect(validateToolArgs(action, missing).valid).toBe(false);
    }
  },
);

describe.each(["CALENDAR_UPDATE_EVENT", "CALENDAR_DELETE_EVENT"])(
  "%s target contract",
  (actionName) => {
    it.each([false, true])(
      "requires typed target scalars through native schemas (Cerebras %s)",
      (cerebrasMode) => {
        const family = promoteSubactionsToActions(
          calendarAction,
          calendarActionPromotionOptions,
        );
        const update = family.find((action) => action.name === actionName);
        if (!update) throw new Error("Missing promoted update tool");
        const tools = normalizeNativeToolsForCall(
          buildPlannerToolsFromActions(family),
          { cerebrasMode },
        ).tools;
        if (!tools) throw new Error("Missing native tools");
        const tool = tools[update.name] as {
          inputSchema: { jsonSchema: ActionParameterSchema };
        };
        for (const args of [
          { targetKind: "query", target: "QA routing check" },
          { targetKind: "eventId", target: "event-123" },
        ]) {
          const errors: string[] = [];
          validateSchema(tool.inputSchema.jsonSchema, args, "", errors);
          expect(errors).toEqual([]);
          expect(validateToolArgs(update, args).valid).toBe(true);
        }
        for (const args of [
          {},
          { target: "title" },
          { targetKind: "query" },
          { targetKind: "query", target: "" },
          { targetKind: "unknown", target: "title" },
          { targetKind: "query", target: { query: "title" } },
        ])
          expect(validateToolArgs(update, args).valid).toBe(false);
      },
    );
  },
);

describe("promoted availability interval contract", () => {
  it.each([false, true])(
    "requires a complete interval in the provider schema (Cerebras %s)",
    (cerebrasMode) => {
      const action = promoteSubactionsToActions(
        calendarAction,
        calendarActionPromotionOptions,
      ).find((entry) => entry.name === "CALENDAR_CHECK_AVAILABILITY");
      if (!action) throw new Error("Missing availability action");
      const tools = normalizeNativeToolsForCall(
        buildPlannerToolsFromActions([action]),
        { cerebrasMode },
      ).tools;
      if (!tools) throw new Error("Missing native tools");
      const schema = (
        tools[action.name] as {
          inputSchema: { jsonSchema: ActionParameterSchema };
        }
      ).inputSchema.jsonSchema;
      const interval = {
        startAt: "2026-09-18T09:15:00-04:00",
        endAt: "2026-09-18T09:30:00-04:00",
      };
      for (const args of [
        {},
        { interval: {} },
        { interval: { startAt: interval.startAt } },
        { interval: { endAt: interval.endAt } },
        { interval: { startAt: interval.startAt, durationMinutes: null } },
        interval,
      ]) {
        const errors: string[] = [];
        validateSchema(schema, args, "", errors);
        expect(errors, JSON.stringify(args)).not.toEqual([]);
        expect(validateToolArgs(action, args).valid).toBe(false);
      }
      expect(
        validateToolArgs(action, { interval: { ...interval, startAt: "" } })
          .valid,
      ).toBe(false);
      for (const args of [
        { interval },
        { interval: { startAt: interval.startAt, durationMinutes: 15 } },
      ]) {
        const errors: string[] = [];
        validateSchema(schema, args, "", errors);
        expect(errors, JSON.stringify(args)).toEqual([]);
        expect(validateToolArgs(action, args).valid).toBe(true);
      }
      expect(
        validateToolArgs(calendarAction, {
          action: "check_availability",
          ...interval,
        }).valid,
      ).toBe(true);
      // The umbrella is a mixed-operation surface; reads do not impose bounds on unrelated operations.
      expect(
        validateToolArgs(calendarAction, {
          action: "update_preferences",
          timeZone: "America/New_York",
        }).valid,
      ).toBe(true);
    },
  );
});
