/** Exercises the registered field's parsed source binding and the real evaluator patch runner. */

import type { CalendarReadBinding } from "@elizaos/contracts";
import {
  AgentRuntime,
  getStreamingContext,
  type Memory,
  type MessageHandlerResult,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
  runWithStreamingContext,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../plugin-assistant/src/runtime/builtin-field-evaluators.js";
import { messageHandlerFromFieldResult } from "../../plugin-assistant/src/services/message/stage1-output.js";
import {
  calendarActionPromotionOptions,
  calendarAction as ownerCalendarAction,
} from "../../plugin-personal-assistant/src/actions/calendar.ts";
import { calendarPlugin } from "./plugin.js";
import {
  calendarReadBindingEvaluator,
  calendarReadBindingField,
} from "./read-binding.js";
import {
  bindFilterEvidence,
  calendarMutationPrerequisites,
  calendarSearchFiltersAreBound,
} from "./search-filter-evidence.js";

describe("Calendar operation bindings", () => {
  it("offers provider-compatible intent strings without weakening host parsing", () => {
    const item = calendarReadBindingField.schema.items;
    if (!item || Array.isArray(item) || typeof item !== "object")
      throw new Error("Expected binding object schema");
    expect(item.properties?.intentId).toEqual({ type: "string" });
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual([
      "intentId",
      "operation",
      "execution",
      "purpose",
      "filterEvidence",
    ]);
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
    { intentId: "intent:2", execution: "required", bound: false },
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
      expect(parsed.calendarReadBindings).toEqual(
        bound
          ? [
              {
                intentId,
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
      // An unbound required read cannot verify the Stage-1 reply.
      expect(parsed.replyText).toBe(
        !bound && execution === "required" ? "" : reply,
      );
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
        [
          {
            intentId: "intent:1",
            operation,
            execution: "required",
            ...(operation === "search_events"
              ? {
                  filterEvidence: [
                    {
                      query: "Meet with Shaw",
                      quote: "Meet with Shaw",
                      origin: "current",
                    },
                  ],
                }
              : {}),
          },
        ],
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
          ...(operation === "search_events"
            ? {
                filterEvidence: [
                  {
                    query: "Meet with Shaw",
                    quote: "Meet with Shaw",
                    origin: "current",
                    sourceMessageId: message.id,
                    sourceActorId: message.entityId,
                    sourceRoomId: message.roomId,
                    sourceCreatedAt: 1000,
                  },
                ],
              }
            : {}),
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

it("binds a literal quoted event title inside the verified current quotation", () => {
  const current = {
    id: "request",
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    createdAt: 1000,
    content: {
      text: 'Read the Calendar event "Alpha demo verified" on November 2, 2026.',
    },
  };
  const quote = 'the Calendar event "Alpha demo verified" on November 2, 2026';
  const bind = (query: string) =>
    bindFilterEvidence(
      [{ query, quote, origin: "current" }],
      current,
      "agent",
      [],
    );
  expect(bind("Alpha demo verified")).toEqual([
    expect.objectContaining({
      query: "Alpha demo verified",
      quote: "Alpha demo verified",
      sourceMessageId: "request",
      sourceActorId: "owner",
      sourceRoomId: "room",
      sourceCreatedAt: 1000,
    }),
  ]);
  expect(bind("Alpha demo")).toBeNull();
  expect(bind("dentist")).toBeNull();
  expect(
    bindFilterEvidence(
      [{ query: "Alpha demo verified", quote, origin: "referent" }],
      current,
      "agent",
      [],
    ),
  ).toBeNull();
});

/** Existing field + real evaluator/streaming carriers; no model, Calendar I/O or mutation. */
describe("Calendar mutation lookup prerequisites", () => {
  const oldTitle = "Alpha QA 2026-11-02 1139Z";
  const originalText =
    "Open calendar and rename my 5 minute test event at 3 PM today to Alpha demo verified, leaving everything else unchanged.";
  function fixture(text = originalText) {
    const runtime = new AgentRuntime({
      character: { name: "Calendar prerequisite", bio: [] },
      logLevel: "fatal",
    });
    for (const action of calendarPlugin.actions ?? [])
      runtime.registerAction(action);
    for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
      runtime.responseHandlerFieldRegistry.register(field);
    runtime.responseHandlerFieldRegistry.register(calendarReadBindingField);
    const message: Memory = {
      id: stringToUuid("mutation-current"),
      agentId: runtime.agentId,
      entityId: stringToUuid("mutation-owner"),
      roomId: stringToUuid("mutation-room"),
      createdAt: 1000,
      content: { text },
    };
    const state = { values: {}, data: {}, text: "" };
    const abort = new AbortController();
    const streaming = { messageId: message.id, abortSignal: abort.signal };
    const context = {
      runtime,
      message,
      state,
      senderRole: "OWNER" as const,
      turnSignal: abort.signal,
    };
    const intents = [
      "Open the Calendar view",
      "Rename the current five-minute 3 PM event without other changes",
    ];
    async function bind(raw: unknown, role: "OWNER" | "USER" = "OWNER") {
      return runWithStreamingContext(streaming, async () => {
        // Replay through the real registered field dispatch and normal plan conversion.
        // These are adverse old retrieval hints, not a fixture-injected FEED tool.
        const fieldRun = await runtime.responseHandlerFieldRegistry.dispatch({
          ...context,
          senderRole: role,
          rawParsed: {
            shouldRespond: "RESPOND",
            contexts: ["simple", "general", "calendar"],
            intents: [...intents],
            replyText: "On it, opening Calendar and renaming it now.",
            replyEffectStatus: "pending",
            candidateActionNames: [
              "VIEWS_SHOW",
              "CALENDAR_SEARCH_EVENTS",
              "CALENDAR_UPDATE_EVENT",
            ],
            calendarReadBindings: raw,
          },
        });
        const parsed = fieldRun.parsed;
        const handler = messageHandlerFromFieldResult(parsed, fieldRun, {
          actions: runtime.actions,
          messageText: message.content.text,
        });
        const beforeRequiresTool = handler.plan.requiresTool;
        await runResponseHandlerEvaluators({
          runtime,
          message,
          state,
          messageHandler: handler,
          availableContexts: [],
          userRoles: [role],
          evaluators: [calendarReadBindingEvaluator],
        });
        return {
          parsed,
          handler,
          beforeRequiresTool,
          fieldRun,
          carrier: getStreamingContext()?.actionConstraints,
        };
      });
    }
    return {
      runtime,
      message,
      state,
      abort,
      streaming,
      context,
      intents,
      bind,
    };
  }
  const feed = {
    intentId: "intent:2",
    operation: "feed",
    execution: "required",
    purpose: "mutation_prerequisite",
    filterEvidence: [],
  };
  const malformedLiveSearch = {
    intentId: "intent:2",
    operation: "search_events",
    execution: "required",
    purpose: "mutation_prerequisite",
    filterEvidence: [
      {
        query: "5 minute test event at 3 PM",
        quote: "5 minute test event at 3 PM today",
        origin: "current",
      },
    ],
  };
  const normalize = (text: string) => text.trim().toLowerCase() || undefined;

  it("routes the actual unequal query/quote mutation proposal to bounded feed without search authority", async () => {
    const f = fixture();
    const { parsed, handler, carrier, beforeRequiresTool, fieldRun } =
      await f.bind([malformedLiveSearch]);
    expect(parsed.replyText).toBe("");
    expect(parsed.calendarReadBindings).toEqual([]);
    expect(handler.plan.intents).toEqual(f.intents);
    expect(handler.plan.requiresTool).toBe(beforeRequiresTool);
    expect(fieldRun.parsed.calendarReadBindings).toEqual([]);
    expect(
      f.runtime.actions.some((action) => action.name === "CALENDAR_FEED"),
    ).toBe(true);
    expect(handler.plan.candidateActions).toEqual([
      "VIEWS_SHOW",
      "CALENDAR_UPDATE_EVENT",
      "CALENDAR_FEED",
    ]);
    expect(
      calendarMutationPrerequisites(
        carrier,
        f.message,
        String(f.runtime.agentId),
      ),
    ).toEqual([
      { intentId: "intent:2", operation: "feed", execution: "required" },
    ]);
    expect(
      calendarSearchFiltersAreBound(
        carrier,
        f.message,
        String(f.runtime.agentId),
        [oldTitle],
        normalize,
      ),
    ).toBe(false);
    expect(
      calendarSearchFiltersAreBound(
        carrier,
        f.message,
        String(f.runtime.agentId),
        ["5 minute test event at 3 PM"],
        normalize,
      ),
    ).toBe(false);
    expect(JSON.stringify(handler.plan)).toContain(
      "A read alone does not complete the mutation",
    );
    expect(JSON.stringify(handler.plan)).toContain(
      "ambiguous matches require clarification",
    );
  });

  it("accepts an explicit unfiltered mutation prerequisite without inventing a requested read", async () => {
    const f = fixture();
    const { parsed, handler, beforeRequiresTool } = await f.bind([feed]);
    expect(parsed.calendarReadBindings).toEqual([]);
    expect(handler.plan.intents).toEqual(f.intents);
    expect(handler.plan.candidateActions).toEqual([
      "VIEWS_SHOW",
      "CALENDAR_UPDATE_EVENT",
      "CALENDAR_FEED",
    ]);
    expect(handler.plan.requiresTool).toBe(beforeRequiresTool);
  });

  it("preserves an actually verified literal search prerequisite and rejects a different query", async () => {
    const f = fixture(`Rename the event ${oldTitle} to Alpha demo verified.`);
    const { carrier, handler } = await f.bind([
      {
        ...malformedLiveSearch,
        filterEvidence: [
          { query: oldTitle, quote: oldTitle, origin: "current" },
        ],
      },
    ]);
    expect(handler.plan.candidateActions).toContain("CALENDAR_SEARCH_EVENTS");
    expect(
      calendarSearchFiltersAreBound(
        carrier,
        f.message,
        String(f.runtime.agentId),
        [oldTitle],
        normalize,
      ),
    ).toBe(true);
    expect(
      calendarSearchFiltersAreBound(
        carrier,
        f.message,
        String(f.runtime.agentId),
        ["different event"],
        normalize,
      ),
    ).toBe(false);
  });

  it("does not turn an invalid requested content search into a feed or prerequisite", async () => {
    const f = fixture();
    const { parsed, carrier, handler } = await f.bind([
      { ...malformedLiveSearch, purpose: "requested_read" },
    ]);
    expect(parsed.replyText).toBe("");
    expect(parsed.calendarReadBindings).toEqual([]);
    expect(
      calendarMutationPrerequisites(
        carrier,
        f.message,
        String(f.runtime.agentId),
      ),
    ).toEqual([]);
    expect(handler.plan.candidateActions).not.toContain("CALENDAR_FEED");
    expect(
      calendarSearchFiltersAreBound(
        carrier,
        f.message,
        String(f.runtime.agentId),
        [oldTitle],
        normalize,
      ),
    ).toBe(false);
  });

  it.each(
    [
      undefined,
      null,
      "not an array",
      [],
      [{ query: "x", quote: "x", origin: "current", actorId: "forged" }],
      [{ query: "x", quote: "x", origin: "other" }],
      [{ query: "x", quote: "", origin: "current" }],
      [{ query: "x".repeat(161), quote: "x", origin: "current" }],
      Array.from({ length: 9 }, () => ({
        query: "x",
        quote: "x",
        origin: "current",
      })),
    ].map((filterEvidence) => ({ filterEvidence })),
  )(
    "does not downgrade malformed prerequisite filter shape %#",
    async ({ filterEvidence }) => {
      const f = fixture();
      const { parsed, carrier, handler } = await f.bind([
        { ...malformedLiveSearch, filterEvidence },
      ]);
      expect(parsed.calendarReadBindings).toEqual([]);
      expect(
        calendarMutationPrerequisites(
          carrier,
          f.message,
          String(f.runtime.agentId),
        ),
      ).toEqual([]);
      expect(handler.plan.candidateActions).not.toContain("CALENDAR_FEED");
      expect(
        calendarSearchFiltersAreBound(
          carrier,
          f.message,
          String(f.runtime.agentId),
          [oldTitle],
          normalize,
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "rejects a duplicate prerequisite after search-to-feed normalization (reverse=%s)",
    (reverse) => {
      const f = fixture();
      const rows = [feed, malformedLiveSearch];
      if (reverse) rows.reverse();
      expect(calendarReadBindingField.parse?.(rows, f.context)).toBeNull();
    },
  );

  it.each(["next_event", "propose_times", "check_availability"])(
    "does not expand prerequisite operations to %s",
    (operation) => {
      const f = fixture();
      expect(
        calendarReadBindingField.parse?.([{ ...feed, operation }], f.context),
      ).toBeNull();
    },
  );

  it("keeps exact carrier identity through a normal same-turn nested context", async () => {
    const f = fixture();
    await runWithStreamingContext(f.streaming, async () => {
      const { carrier } = await f.bind([feed]);
      await runWithStreamingContext({ messageId: f.message.id }, async () => {
        expect(getStreamingContext()?.actionConstraints).toBe(carrier);
        expect(
          calendarMutationPrerequisites(
            getStreamingContext()?.actionConstraints,
            f.message,
            String(f.runtime.agentId),
          ),
        ).toHaveLength(1);
      });
      expect(
        calendarMutationPrerequisites(
          new Map(),
          f.message,
          String(f.runtime.agentId),
        ),
      ).toEqual([]);
    });
  });

  it.each(["id", "room", "actor", "time", "body", "agent", "abort"])(
    "does not expose prerequisite guidance after current-request %s changes",
    async (fault) => {
      const f = fixture();
      const { carrier } = await f.bind([feed]);
      const current = { ...f.message, content: { ...f.message.content } };
      if (fault === "id") current.id = stringToUuid("different-message");
      if (fault === "room") current.roomId = stringToUuid("different-room");
      if (fault === "actor") current.entityId = stringToUuid("different-owner");
      if (fault === "time") current.createdAt = 1001;
      if (fault === "body") current.content.text = "different request";
      if (fault === "agent") current.agentId = stringToUuid("different-agent");
      if (fault === "abort") f.abort.abort();
      expect(
        calendarMutationPrerequisites(
          carrier,
          current,
          String(f.runtime.agentId),
        ),
      ).toEqual([]);
      expect(
        calendarSearchFiltersAreBound(
          carrier,
          current,
          String(f.runtime.agentId),
          [oldTitle],
          normalize,
        ),
      ).toBe(false);
    },
  );

  it("does not create prerequisite custody for a non-owner", async () => {
    const f = fixture();
    const { carrier, handler } = await f.bind([feed], "USER");
    expect(
      calendarMutationPrerequisites(
        carrier,
        f.message,
        String(f.runtime.agentId),
      ),
    ).toEqual([]);
    expect(handler.plan.candidateActions).not.toContain("CALENDAR_FEED");
  });

  it.each(["future", "room", "actor", "agent"])(
    "rejects %s history as literal search evidence",
    (fault) => {
      const f = fixture();
      const source: Memory = {
        ...f.message,
        id: stringToUuid("prior-source"),
        createdAt: 900,
        entityId: f.runtime.agentId,
        content: { text: `Today: ${oldTitle}, 3:00 to 3:05 pm.` },
      };
      if (fault === "future") source.createdAt = 1001;
      if (fault === "room") source.roomId = stringToUuid("foreign-room");
      if (fault === "actor") source.entityId = stringToUuid("foreign-speaker");
      if (fault === "agent") source.agentId = stringToUuid("foreign-agent");
      expect(
        bindFilterEvidence(
          [{ query: oldTitle, quote: oldTitle, origin: "referent" }],
          f.message,
          String(f.runtime.agentId),
          [source],
        ),
      ).toBeNull();
    },
  );

  it("ignores model-plan prerequisite metadata without opaque host custody", async () => {
    const f = fixture();
    await runWithStreamingContext(f.streaming, async () => {
      const handler: MessageHandlerResult = {
        processMessage: "RESPOND",
        thought: "",
        plan: {
          contexts: ["general"],
          intents: f.intents,
          candidateActions: ["VIEWS_SHOW"],
          calendarReadBindings: [],
        },
      };
      Object.assign(handler.plan, { calendarMutationPrerequisites: [feed] });
      await runResponseHandlerEvaluators({
        runtime: f.runtime,
        message: f.message,
        state: f.state,
        messageHandler: handler,
        availableContexts: [],
        userRoles: ["OWNER"],
        evaluators: [calendarReadBindingEvaluator],
      });
      expect(handler.plan.candidateActions).toEqual(["VIEWS_SHOW"]);
      expect(
        calendarMutationPrerequisites(
          getStreamingContext()?.actionConstraints,
          f.message,
          String(f.runtime.agentId),
        ),
      ).toEqual([]);
    });
  });
});
