/**
 * Exercises the real planner-to-provider schema boundary. Calendar's operation
 * union must not turn absent travel fields (or their aliases) into required
 * strings that the planner has to invent just to satisfy the wire grammar.
 */
import type { Action, ActionParameterSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../packages/core/src/actions/promote-subactions.js";
import { buildPlannerToolsFromActions } from "../../../packages/core/src/actions/to-tool.js";
import { validateToolArgs } from "../../../packages/core/src/actions/validate-tool-args.js";
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
    "keeps optional detail fields optional after provider normalization (Cerebras: %s)",
    (cerebrasMode) => {
      const family = promoteSubactionsToActions(parent);
      expect(family.length).toBeGreaterThan(1);
      const normalized = normalizeNativeToolsForCall(
        buildPlannerToolsFromActions(family),
        { cerebrasMode },
      ).tools;
      if (!normalized)
        throw new Error("calendar tool family was not normalized");
      for (const action of family) {
        const tool = normalized[action.name] as {
          strict?: boolean;
          inputSchema: { jsonSchema: ActionParameterSchema };
        };
        expect(tool.strict).toBe(false);
        const details = tool.inputSchema.jsonSchema.properties?.details;
        if (
          action.parameters?.some((parameter) => parameter.name === "details")
        ) {
          expect(details?.properties?.travelOriginAddress).toMatchObject({
            type: "string",
          });
          expect(details?.required ?? []).toEqual([]);
        }
      }
    },
  );

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
