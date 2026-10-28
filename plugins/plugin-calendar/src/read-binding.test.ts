/** Exercises the registered field's parsed source binding and the real evaluator patch runner. */

import type { CalendarReadBinding } from "@elizaos/contracts";
import {
  AgentRuntime,
  type Memory,
  type MessageHandlerResult,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  calendarActionPromotionOptions,
  calendarAction as ownerCalendarAction,
} from "../../plugin-personal-assistant/src/actions/calendar.ts";
import { calendarPlugin } from "./plugin.js";
import {
  calendarReadBindingEvaluator,
  calendarReadBindingField,
} from "./read-binding.js";

describe("Calendar operation bindings", () => {
  it("offers provider-compatible intent strings without weakening host parsing", () => {
    const item = calendarReadBindingField.schema.items;
    if (!item || Array.isArray(item) || typeof item !== "object")
      throw new Error("Expected binding object schema");
    expect(item.properties?.intentId).toEqual({ type: "string" });
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["intentId", "operation", "execution"]);
    const context = {} as Parameters<
      NonNullable<typeof calendarReadBindingField.parse>
    >[1];
    for (const intentId of [
      "intent:0",
      "intent:-1",
      "intent:01",
      "intent:1x",
      "other:1",
      "intent:1\nx",
      "intent:",
      1,
      null,
    ]) {
      expect(
        calendarReadBindingField.parse?.(
          [{ intentId, operation: "feed", execution: "required" }],
          context,
        ),
      ).toBeNull();
    }
  });
  it("activates for an owner Notes request when Calendar reads are registered", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Notes request", bio: [] },
      logLevel: "fatal",
    });
    for (const action of promoteSubactionsToActions(
      ownerCalendarAction,
      calendarActionPromotionOptions,
    ))
      runtime.registerAction(action);
    expect(
      await calendarReadBindingField.shouldRun?.({
        runtime,
        message: {
          id: stringToUuid("note-request"),
          agentId: runtime.agentId,
          entityId: stringToUuid("owner"),
          roomId: stringToUuid("room"),
          createdAt: 1000,
          content: { text: "Read the selected note" },
        },
        state: { values: {}, data: {}, text: "" },
        senderRole: "OWNER",
        turnSignal: new AbortController().signal,
      }),
    ).toBe(true);
  });
  it("binds only existing same-response intents without an arbitrary ID cap", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Intent identity", bio: [] },
      logLevel: "fatal",
    });
    const message: Memory = {
      id: stringToUuid("intent-request"),
      agentId: runtime.agentId,
      entityId: stringToUuid("owner"),
      roomId: stringToUuid("room"),
      createdAt: 1000,
      content: { text: "Calendar read" },
    };
    const context = {
      runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      senderRole: "OWNER" as const,
      turnSignal: new AbortController().signal,
    };
    const intents = Array.from(
      { length: 1024 },
      (_, i) => `Current intent ${i + 1}`,
    );
    for (const [intentId, accepted] of [
      ["intent:1024", true],
      ["intent:1025", false],
    ] as const) {
      const value = calendarReadBindingField.parse?.(
        [{ intentId, operation: "feed", execution: "required" }],
        context,
      );
      if (!value)
        throw new Error("Canonical ID rejected before current-intent binding");
      const parsed = { intents, calendarReadBindings: value };
      const effect = await calendarReadBindingField.handle?.({
        ...context,
        parsed,
        value,
      });
      effect?.mutateResult?.(parsed);
      expect(parsed.calendarReadBindings).toEqual(
        accepted
          ? [
              {
                intentId,
                operation: "feed",
                execution: "required",
                sourceMessageId: message.id,
                roomId: message.roomId,
                actorId: message.entityId,
                requestedAt: 1000,
              },
            ]
          : [],
      );
    }
  });
  it("does not force a tool requirement for a conditional-only binding", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Conditional binding", bio: [] },
      logLevel: "fatal",
    });
    const message: Memory = {
      id: stringToUuid("conditional"),
      agentId: runtime.agentId,
      roomId: stringToUuid("room"),
      entityId: stringToUuid("owner"),
      createdAt: 1000,
      content: { text: "If I have a note, read my next Calendar event" },
    };
    const handler: MessageHandlerResult = {
      processMessage: "RESPOND",
      thought: "",
      plan: {
        contexts: ["general"],
        requiresTool: false,
        intents: [message.content.text ?? ""],
        calendarReadBindings: [
          {
            intentId: "intent:1",
            operation: "next_event",
            execution: "conditional",
            sourceMessageId: message.id ?? "",
            roomId: message.roomId,
            actorId: message.entityId,
            requestedAt: 1000,
          },
        ],
      },
    };
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      messageHandler: handler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: [calendarReadBindingEvaluator],
    });
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions).toBeUndefined();
  });
  it("activates on registered Calendar read operations from both plugin hosts", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Registered Calendar", bio: [] },
      logLevel: "fatal",
    });
    const context = {
      runtime,
      message: {
        id: stringToUuid("request"),
        agentId: runtime.agentId,
        entityId: stringToUuid("owner"),
        roomId: stringToUuid("room"),
        createdAt: 1000,
        content: { text: "Read my next Calendar event" },
      },
      state: { values: {}, data: {}, text: "" },
      senderRole: "OWNER" as const,
      turnSignal: new AbortController().signal,
    };
    expect(await calendarReadBindingField.shouldRun?.(context)).toBe(false);
    for (const action of calendarPlugin.actions ?? [])
      runtime.registerAction(action);
    expect(await calendarReadBindingField.shouldRun?.(context)).toBe(true);
    for (const action of promoteSubactionsToActions(
      ownerCalendarAction,
      calendarActionPromotionOptions,
    ))
      runtime.registerAction(action);
    expect(
      runtime.actions.some((action) => action.name === "CALENDAR_NEXT_EVENT"),
    ).toBe(true);
    expect(await calendarReadBindingField.shouldRun?.(context)).toBe(true);
    expect(
      await calendarReadBindingField.shouldRun?.({
        ...context,
        senderRole: "USER",
      }),
    ).toBe(false);
  });
  it.each([
    {
      text: "Read my next Calendar event",
      operation: "next_event",
      execution: "required",
      action: "CALENDAR_NEXT_EVENT",
    },
    {
      text: "Read my Calendar agenda for next week",
      operation: "feed",
      action: "CALENDAR_FEED",
    },
    {
      text: "Find an open 45-minute time for a planning call Friday afternoon",
      operation: "propose_times",
      action: "CALENDAR_PROPOSE_TIMES",
    },
    {
      text: "Check whether 11:00 to 11:30 Thursday is free",
      operation: "check_availability",
      action: "CALENDAR_CHECK_AVAILABILITY",
    },
  ] as const)(
    "preserves the declared $operation rather than a feed heuristic for $text",
    async ({ text, operation, action }) => {
      const runtime = new AgentRuntime({
        character: { name: "Binding", bio: [] },
        logLevel: "fatal",
      });
      const message: Memory = {
        id: stringToUuid("current-request"),
        agentId: runtime.agentId,
        entityId: stringToUuid("owner"),
        roomId: stringToUuid("room"),
        createdAt: 1000,
        content: { text },
      };
      const state = { values: {}, data: {}, text: "" };
      const context = {
        runtime,
        message,
        state,
        senderRole: "OWNER" as const,
        turnSignal: new AbortController().signal,
      };
      const value = calendarReadBindingField.parse?.(
        [{ intentId: "intent:1", operation, execution: "required" }],
        context,
      );
      if (!value) throw new Error("Binding rejected");
      const parsed = { intents: [text], calendarReadBindings: value };
      const effect = await calendarReadBindingField.handle?.({
        ...context,
        parsed,
        value,
      });
      effect?.mutateResult?.(parsed);
      const bindings = parsed.calendarReadBindings as CalendarReadBinding[];
      expect(bindings).toEqual([
        {
          intentId: "intent:1",
          operation,
          execution: "required",
          sourceMessageId: message.id,
          roomId: message.roomId,
          actorId: message.entityId,
          requestedAt: 1000,
        },
      ]);
      const handler: MessageHandlerResult = {
        processMessage: "RESPOND",
        thought: "",
        plan: {
          contexts: ["general"],
          intents: [text],
          candidateActions: ["VIEWS_SHOW", "NOTES_LIST", "CALENDAR_FEED"],
          calendarReadBindings: bindings,
        },
      };
      await runResponseHandlerEvaluators({
        runtime,
        message,
        state,
        messageHandler: handler,
        availableContexts: [],
        userRoles: ["OWNER"],
        evaluators: [calendarReadBindingEvaluator],
      });
      expect(handler.plan.candidateActions).toEqual([
        "VIEWS_SHOW",
        "NOTES_LIST",
        action,
      ]);
      expect(handler.plan.intents).toEqual([text]);
      expect(handler.plan.contexts).toContain("calendar");
    },
  );
  it("rejects caller-provided provenance and duplicate operation rows", () => {
    const context = {} as Parameters<
      NonNullable<typeof calendarReadBindingField.parse>
    >[1];
    expect(
      calendarReadBindingField.parse?.(
        [
          {
            intentId: "intent:1",
            operation: "next_event",
            execution: "required",
            actorId: "invented",
          },
        ],
        context,
      ),
    ).toBeNull();
    expect(
      calendarReadBindingField.parse?.(
        [
          {
            intentId: "intent:1",
            operation: "next_event",
            execution: "required",
          },
          {
            intentId: "intent:1",
            operation: "next_event",
            execution: "required",
          },
        ],
        context,
      ),
    ).toBeNull();
    expect(calendarReadBindingField.parse?.([], context)).toEqual([]);
    expect(calendarReadBindingField.parse?.(undefined, context)).toEqual([]);
  });
});
