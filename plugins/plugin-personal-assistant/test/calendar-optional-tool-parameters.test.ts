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
import { calendarAction } from "../src/actions/calendar.js";
import { resolveCreateEventTravelIntent } from "../src/travel-time/calendar-create.js";

const domainCalendarAction = createCalendarActionRunner({
  runTextModel: async () => null,
  runJsonModel: async () => null,
  recentConversationTexts: async () => [],
});

describe.each([
  ["personal-assistant calendar", calendarAction],
  ["domain calendar", domainCalendarAction],
] as const)("%s optional native arguments", (_name, parent) => {
  it.each([false, true])(
    "admits sparse calendar creates through the provider schema without weakening travel types (Cerebras: %s)",
    (cerebrasMode) => {
      const family = promoteSubactionsToActions(parent);
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
          startAt: "2026-09-11T16:00:00.000Z",
          endAt: "2026-09-11T17:00:00.000Z",
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
        startAt: "2026-07-27T16:00:00.000Z",
        endAt: "2026-07-27T17:00:00.000Z",
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
