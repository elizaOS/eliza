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
  it("binds a bare intent number to its canonical intent ID", async () => {
    // Live tj-97b3ddd147b529: Stage 1 wrote intentId "1" for "Find me a
    // 30-minute slot tomorrow afternoon.", and the whole binding was dropped,
    // so CALENDAR_PROPOSE_TIMES was never offered.
    const runtime = new AgentRuntime({
      character: { name: "Bare intent number", bio: [] },
      logLevel: "fatal",
    });
    const text = "Find me a 30-minute slot tomorrow afternoon.";
    const message: Memory = {
      id: stringToUuid("bare-intent"),
      agentId: runtime.agentId,
      entityId: stringToUuid("owner"),
      roomId: stringToUuid("room"),
      createdAt: 1000,
      content: { text },
    };
    const context = {
      runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      senderRole: "OWNER" as const,
      turnSignal: new AbortController().signal,
    };
    const value = calendarReadBindingField.parse?.(
      [{ intentId: "1", operation: "propose_times", execution: "required" }],
      context,
    );
    expect(value).toEqual([
      {
        intentId: "intent:1",
        operation: "propose_times",
        execution: "required",
      },
    ]);
    if (!value) throw new Error("Bare intent number rejected");
    const parsed = { intents: [text], calendarReadBindings: value };
    const effect = await calendarReadBindingField.handle?.({
      ...context,
      parsed,
      value,
    });
    effect?.mutateResult?.(parsed);
    const bindings = parsed.calendarReadBindings as CalendarReadBinding[];
    expect(bindings.map(({ intentId }) => intentId)).toEqual(["intent:1"]);
    const handler: MessageHandlerResult = {
      processMessage: "RESPOND",
      thought: "",
      plan: {
        contexts: ["calendar"],
        intents: [text],
        candidateActions: [],
        calendarReadBindings: bindings,
      },
    };
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: context.state,
      messageHandler: handler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: [calendarReadBindingEvaluator],
    });
    expect(handler.plan.candidateActions).toEqual(["CALENDAR_PROPOSE_TIMES"]);
    expect(handler.plan.requiresTool).toBe(true);
    // Both spellings name one intent, so the same read twice stays a duplicate.
    expect(
      calendarReadBindingField.parse?.(
        [
          { intentId: "1", operation: "feed", execution: "required" },
          { intentId: "intent:1", operation: "feed", execution: "required" },
        ],
        context,
      ),
    ).toBeNull();
    for (const intentId of ["0", "01", "-1", "1x", " 1", "1\nx"])
      expect(
        calendarReadBindingField.parse?.(
          [{ intentId, operation: "feed", execution: "required" }],
          context,
        ),
      ).toBeNull();
  });
  it.each([
    { intentId: "intent:1", execution: "required", bound: true },
    { intentId: "intent:1", execution: "conditional", bound: true },
    { intentId: "intent:2", execution: "required", bound: true },
    { intentId: "intent:2", execution: "conditional", bound: false },
  ] as const)(
    "binds $intentId ($execution) to a message whose Stage 1 lists no intents",
    async ({ intentId, execution, bound }) => {
      // Live tj-6a95e9c522dc6a: intents [] with a required intent:1 next_event
      // read. The binding was dropped and the reply copied from earlier chat
      // ("Coffee's today") shipped, but Coffee was the day before.
      const runtime = new AgentRuntime({
        character: { name: "No listed intents", bio: [] },
        logLevel: "fatal",
      });
      const text = "Um, when am I supposed to have coffee?";
      const reply = "Coffee's today, 9 to 10 AM.";
      const message: Memory = {
        id: stringToUuid("no-listed-intents"),
        agentId: runtime.agentId,
        entityId: stringToUuid("owner"),
        roomId: stringToUuid("room"),
        createdAt: 1000,
        content: { text },
      };
      const context = {
        runtime,
        message,
        state: { values: {}, data: {}, text: "" },
        senderRole: "OWNER" as const,
        turnSignal: new AbortController().signal,
      };
      const value = calendarReadBindingField.parse?.(
        [{ intentId, operation: "next_event", execution }],
        context,
      );
      if (!value) throw new Error("Canonical ID rejected");
      const parsed = {
        intents: [] as string[],
        replyText: reply,
        calendarReadBindings: value,
      };
      const effect = await calendarReadBindingField.handle?.({
        ...context,
        parsed,
        value,
      });
      effect?.mutateResult?.(parsed);
      // The message is the only intent, so a required read naming intent:2
      // still reads it as intent:1 instead of only withholding the reply.
      expect(parsed.calendarReadBindings).toEqual(
        bound
          ? [
              {
                intentId: "intent:1",
                operation: "next_event",
                execution,
                sourceMessageId: message.id,
                roomId: message.roomId,
                actorId: message.entityId,
                requestedAt: 1000,
              },
            ]
          : [],
      );
      expect(parsed.intents).toEqual(bound ? [text] : []);
      // A required read that named no current intent cannot verify the reply.
      expect(parsed.replyText).toBe(
        intentId === "intent:2" && execution === "required" ? "" : reply,
      );
    },
  );
  it.each([
    {
      name: "QA coffee date from earlier chat",
      text: "So is QA coffee today?",
      reply:
        "No, QA coffee is tomorrow, Monday, November 2, 9:00 to 10:00 AM Pacific. Not today.",
      operation: "search_events",
    },
    {
      name: "empty agenda",
      text: "Anything on today?",
      reply: "You have nothing on your calendar today.",
      operation: "feed",
    },
    {
      name: "current date",
      text: "What's the date?",
      reply: "Today is Sunday, November 1.",
    },
    {
      name: "current time",
      text: "What time is it?",
      reply: "It's 9:12 AM Pacific.",
    },
    {
      name: "reminder",
      text: "When will you remind me?",
      reply: "Your reminder is set for tomorrow at 9 AM.",
    },
    {
      name: "planned Calendar context",
      text: "So is QA coffee today?",
      reply: "QA coffee is tomorrow at 9 AM.",
      contexts: ["calendar"],
    },
    {
      name: "listed intent",
      text: "So is QA coffee today?",
      reply: "QA coffee is tomorrow at 9 AM.",
      intents: ["check whether QA coffee is today"],
    },
    {
      name: "claimed effect",
      text: "Move QA coffee to tomorrow at 9.",
      reply: "QA coffee is now tomorrow at 9 AM.",
      replyEffectStatus: "applied",
    },
  ] as const)(
    "grounds a direct reply only when it states Calendar facts ($name)",
    async (row) => {
      // Live tj-90caa2045f354a / tj-91807fc80cdfb9: contexts [simple], intents
      // [], no binding, and the reply restated the event from earlier chat.
      const runtime = new AgentRuntime({
        character: { name: "Direct Calendar fact", bio: [] },
        logLevel: "fatal",
      });
      const message: Memory = {
        id: stringToUuid(`direct-${row.name}`),
        agentId: runtime.agentId,
        entityId: stringToUuid("owner"),
        roomId: stringToUuid("room"),
        createdAt: 1000,
        content: { text: row.text },
      };
      const context = {
        runtime,
        message,
        state: { values: {}, data: {}, text: "" },
        senderRole: "OWNER" as const,
        turnSignal: new AbortController().signal,
      };
      const value = calendarReadBindingField.parse?.([], context);
      if (!value) throw new Error("Empty bindings rejected");
      const intents: readonly string[] =
        "intents" in row ? [...row.intents] : [];
      const parsed = {
        shouldRespond: "RESPOND",
        contexts: "contexts" in row ? [...row.contexts] : ["simple"],
        intents: [...intents],
        replyText: row.reply,
        replyEffectStatus:
          "replyEffectStatus" in row ? row.replyEffectStatus : "none",
        calendarReadBindings: value,
      };
      const effect = await calendarReadBindingField.handle?.({
        ...context,
        parsed,
        value,
      });
      effect?.mutateResult?.(parsed);
      const operation = "operation" in row ? row.operation : undefined;
      expect(parsed.calendarReadBindings).toEqual(
        operation
          ? [
              {
                intentId: "intent:1",
                operation,
                execution: "required",
                sourceMessageId: message.id,
                roomId: message.roomId,
                actorId: message.entityId,
                requestedAt: 1000,
              },
            ]
          : [],
      );
      expect(parsed.intents).toEqual(operation ? [row.text] : intents);
      expect(parsed.replyText).toBe(operation ? "" : row.reply);
    },
  );
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
    {
      text: "What time is the event called Meet with Shaw?",
      operation: "search_events",
      action: "CALENDAR_SEARCH_EVENTS",
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
      expect(handler.plan.requiresTool).toBe(true);
    },
  );
  it.each(["What did you say earlier about the meeting?", "Hello"])(
    "does not force a Calendar lookup for an unbound request: %s",
    async (text) => {
      const runtime = new AgentRuntime({
        character: { name: "Unbound read", bio: [] },
        logLevel: "fatal",
      });
      const message: Memory = {
        id: stringToUuid("unbound-request"),
        agentId: runtime.agentId,
        entityId: stringToUuid("owner"),
        roomId: stringToUuid("room"),
        createdAt: 1000,
        content: { text },
      };
      const handler: MessageHandlerResult = {
        processMessage: "RESPOND",
        thought: "",
        plan: {
          contexts: ["simple"],
          intents: [text],
          calendarReadBindings: [],
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
      expect(handler.plan.contexts).toEqual(["simple"]);
      expect(handler.plan.requiresTool).not.toBe(true);
      expect(handler.plan.candidateActions ?? []).toEqual([]);
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
