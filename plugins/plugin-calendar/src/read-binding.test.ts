/** Exercises the registered field's parsed source binding and the real evaluator patch runner. */

import type { CalendarReadBinding } from "@elizaos/contracts";
import {
  AgentRuntime,
  type Memory,
  type MessageHandlerResult,
  promoteSubactionsToActions,
  ResponseHandlerFieldRegistry,
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

/** One Stage-1 HANDLE_RESPONSE as the probe corpus recorded it. */
type RecordedStage1 = {
  text: string;
  reply: string;
  bindings: unknown;
  contexts?: string[];
  intents?: string[];
  status?: string;
};

/**
 * Replays a recorded Stage-1 output through the real field registry and the
 * read-binding evaluator, with no model call. The plan carries a binding only
 * from a handled trace, as stage1-output.ts copies it.
 */
async function replayStage1(row: RecordedStage1) {
  const runtime = new AgentRuntime({
    character: { name: "Recorded Stage 1", bio: [] },
    logLevel: "fatal",
  });
  for (const action of calendarPlugin.actions ?? [])
    runtime.registerAction(action);
  const message: Memory = {
    id: stringToUuid("recorded-stage1"),
    agentId: runtime.agentId,
    entityId: stringToUuid("owner"),
    roomId: stringToUuid("room"),
    createdAt: 1000,
    content: { text: row.text },
  };
  const state = { values: {}, data: {}, text: "" };
  const fields = new ResponseHandlerFieldRegistry();
  fields.register(calendarReadBindingField);
  const run = await fields.dispatch({
    rawParsed: {
      shouldRespond: "RESPOND",
      contexts: row.contexts ?? ["simple"],
      intents: row.intents ?? [],
      candidateActionNames: [],
      replyText: row.reply,
      replyEffectStatus: row.status ?? "none",
      calendarReadBindings: row.bindings,
    },
    runtime,
    message,
    state,
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  });
  const trace = run.traces.find(
    (entry) => entry.fieldName === "calendarReadBindings",
  );
  const handler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: run.parsed.contexts,
      intents: run.parsed.intents,
      candidateActions: [],
      ...(trace?.parseOutcome === "ok" && trace.handled
        ? {
            calendarReadBindings: run.parsed
              .calendarReadBindings as CalendarReadBinding[],
          }
        : {}),
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
  const provenance = {
    sourceMessageId: message.id,
    roomId: message.roomId,
    actorId: message.entityId,
    requestedAt: 1000,
  };
  return { run, trace, handler, provenance };
}

const COFFEE = "Um, when am I supposed to have coffee?";
const STALE_COFFEE = "Coffee's today, 9 to 10 AM.";
const QA = "So is QA coffee today?";
const STALE_QA = "No, QA coffee is tomorrow at 9 AM.";
const NEXT_EVENT = {
  intentId: "intent:1",
  operation: "next_event",
  execution: "required",
} as const;
const WITHHELD = "Withheld the reply of an unbound required Calendar read";

describe("Calendar operation bindings", () => {
  it("offers provider-compatible intent strings without weakening host parsing", async () => {
    const item = calendarReadBindingField.schema.items;
    if (!item || Array.isArray(item) || typeof item !== "object")
      throw new Error("Expected binding object schema");
    expect(item.properties?.intentId).toEqual({ type: "string" });
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["intentId", "operation", "execution"]);
    for (const intentId of [
      "intent:0",
      "intent:-1",
      "intent:01",
      "intent:1x",
      "other:1",
      "intent:1\nx",
      "intent:",
      "0",
      "01",
      "-1",
      "1x",
      " 1",
      "1\nx",
      1,
      null,
    ]) {
      const { run, trace } = await replayStage1({
        text: COFFEE,
        reply: STALE_COFFEE,
        bindings: [{ intentId, operation: "feed", execution: "required" }],
      });
      expect(run.parsed.calendarReadBindings).toEqual([]);
      expect(run.parsed.intents).toEqual([]);
      expect(run.parsed.replyText).toBe("");
      expect(trace?.debug).toEqual([
        "Calendar read binding did not name a current intent",
        WITHHELD,
      ]);
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
  it("never binds caller-provided provenance and binds a repeated read once", async () => {
    const context = {} as Parameters<
      NonNullable<typeof calendarReadBindingField.parse>
    >[1];
    const invented = await replayStage1({
      text: COFFEE,
      reply: STALE_COFFEE,
      bindings: [{ ...NEXT_EVENT, actorId: "invented" }],
    });
    expect(invented.run.parsed.calendarReadBindings).toEqual([]);
    expect(invented.run.parsed.replyText).toBe("");
    const repeated = await replayStage1({
      text: COFFEE,
      reply: STALE_COFFEE,
      bindings: [NEXT_EVENT, NEXT_EVENT],
    });
    expect(repeated.run.parsed.calendarReadBindings).toEqual([
      { ...NEXT_EVENT, ...repeated.provenance },
    ]);
    expect(calendarReadBindingField.parse?.([], context)).toEqual([]);
    expect(calendarReadBindingField.parse?.(undefined, context)).toEqual([]);
  });
});

// Rows from the 211-row calendar probe corpus (union.probe.test.ts), replayed
// from their recorded Stage-1 output. At 44ecc6c0 every shape below except
// the controls was a parse soft fail that shipped the stale draft.
describe("Calendar read binding normalization", () => {
  it.each([
    { row: "C4", contexts: ["simple"] },
    { row: "C10", contexts: ["calendar"] },
  ])(
    "binds '1' and 'intent:1' copies of one read as that read ($row)",
    async ({ contexts }) => {
      const { run, trace, handler, provenance } = await replayStage1({
        text: COFFEE,
        reply: STALE_COFFEE,
        contexts,
        bindings: [{ ...NEXT_EVENT, intentId: "1" }, NEXT_EVENT],
      });
      expect(trace).toMatchObject({ parseOutcome: "ok", handled: true });
      expect(run.parsed.calendarReadBindings).toEqual([
        { ...NEXT_EVENT, ...provenance },
      ]);
      expect(run.parsed.intents).toEqual([COFFEE]);
      expect(handler.plan.candidateActions).toEqual(["CALENDAR_NEXT_EVENT"]);
      expect(handler.plan.requiresTool).toBe(true);
    },
  );
  it.each([
    {
      row: "C5",
      bindings: [{ ...NEXT_EVENT, reason: "asks when coffee is" }],
      rejected: "carried a key other than intentId, operation and execution",
    },
    {
      row: "S9",
      contexts: ["calendar"],
      text: QA,
      reply: STALE_QA,
      bindings: [
        {
          intentId: "intent:1",
          operation: "search_events",
          execution: "required",
          reason: "x",
        },
      ],
      rejected: "carried a key other than intentId, operation and execution",
    },
    {
      row: "C7",
      bindings: [{ ...NEXT_EVENT, intentId: "intent:0" }],
      rejected: "did not name a current intent",
    },
    {
      row: "C8",
      bindings: [NEXT_EVENT, { ...NEXT_EVENT, operation: "agenda" }],
      rejected: "named an unknown operation or execution",
    },
    {
      row: "adversarial M4",
      bindings: [NEXT_EVENT, { ...NEXT_EVENT, operation: "list_everything" }],
      rejected: "named an unknown operation or execution",
    },
    {
      row: "a read both required and conditional",
      bindings: [NEXT_EVENT, { ...NEXT_EVENT, execution: "conditional" }],
      rejected: "bound one read as both required and conditional",
    },
  ])(
    "withholds the draft behind a rejected required read ($row)",
    async ({ contexts, text, reply, bindings, rejected }) => {
      const { run, trace, handler } = await replayStage1({
        text: text ?? COFFEE,
        reply: reply ?? STALE_COFFEE,
        contexts,
        bindings,
      });
      expect(trace).toMatchObject({
        parseOutcome: "ok",
        handled: true,
        debug: [`Calendar read binding ${rejected}`, WITHHELD],
      });
      // Nothing binds, no item is remapped or dropped to save its sibling.
      expect(run.parsed.calendarReadBindings).toEqual([]);
      expect(run.parsed.intents).toEqual([]);
      expect(run.parsed.replyText).toBe("");
      expect(run.parsed.contexts).toEqual(contexts ?? ["simple"]);
      expect(handler.plan.requiresTool).not.toBe(true);
      expect(handler.plan.candidateActions).toEqual([]);
    },
  );
  it.each([
    {
      row: "L27",
      text: "Bye!",
      reply: "See you tomorrow!",
      bindings: {
        intentId: "intent:1",
        operation: "feed",
        execution: "required",
      },
    },
    { row: "C6", text: COFFEE, reply: STALE_COFFEE, bindings: NEXT_EVENT },
    {
      row: "S10",
      contexts: ["calendar"],
      text: QA,
      reply: STALE_QA,
      bindings: {
        intentId: "intent:1",
        operation: "search_events",
        execution: "required",
      },
    },
    {
      row: "a list with a bare string",
      text: COFFEE,
      reply: STALE_COFFEE,
      bindings: [NEXT_EVENT, "next_event"],
    },
  ])(
    "leaves a non-list binding unparsed and its reply as written ($row)",
    async (row) => {
      const { run, trace, handler } = await replayStage1(row);
      expect(trace?.parseOutcome).toBe("soft-fail");
      expect(run.parsed.replyText).toBe(row.reply);
      expect(handler.plan.calendarReadBindings).toBeUndefined();
      expect(handler.plan.requiresTool).not.toBe(true);
    },
  );
  it.each([
    {
      row: "A5",
      bindings: [
        { ...NEXT_EVENT, intentId: "intent:2", execution: "conditional" },
      ],
      bound: false,
    },
    {
      row: "a conditional read with an extra key",
      bindings: [{ ...NEXT_EVENT, execution: "conditional", reason: "x" }],
      bound: false,
    },
    {
      row: "C12",
      bindings: [{ ...NEXT_EVENT, execution: "conditional" }],
      bound: true,
    },
    {
      row: "C12 twice",
      bindings: [
        { ...NEXT_EVENT, intentId: "1", execution: "conditional" },
        { ...NEXT_EVENT, execution: "conditional" },
      ],
      bound: true,
    },
  ])(
    "keeps the draft: a conditional read never withholds it ($row)",
    async ({ bindings, bound }) => {
      const { run, handler, provenance } = await replayStage1({
        text: COFFEE,
        reply: STALE_COFFEE,
        bindings,
      });
      expect(handler.plan.calendarReadBindings ?? []).toEqual(
        bound
          ? [{ ...NEXT_EVENT, execution: "conditional", ...provenance }]
          : [],
      );
      expect(run.parsed.replyText).toBe(STALE_COFFEE);
      expect(handler.plan.requiresTool).not.toBe(true);
    },
  );
  it.each([
    { row: "S1", bindings: [NEXT_EVENT] },
    { row: "C3", bindings: [{ ...NEXT_EVENT, intentId: "1" }] },
    {
      row: "S5",
      text: QA,
      reply: STALE_QA,
      bindings: [{ ...NEXT_EVENT, operation: "search_events" }],
    },
  ])(
    "binds a single required read as before ($row)",
    async ({ text, reply, bindings }) => {
      const { run, handler, provenance } = await replayStage1({
        text: text ?? COFFEE,
        reply: reply ?? STALE_COFFEE,
        bindings,
      });
      expect(run.parsed.calendarReadBindings).toEqual([
        {
          ...NEXT_EVENT,
          operation: bindings[0]?.operation,
          ...provenance,
        },
      ]);
      expect(run.parsed.intents).toEqual([text ?? COFFEE]);
      expect(handler.plan.requiresTool).toBe(true);
    },
  );
  it.each([
    { row: "S2", intents: [], intentId: "intent:2", bound: false },
    { row: "A15", intents: [], intentId: "2", bound: false },
    {
      row: "A8",
      intents: ["Say hi to Sam", "Is QA coffee today"],
      intentId: "intent:3",
      bound: false,
    },
    {
      row: "two declared intents",
      intents: ["Say hi to Sam", "Is QA coffee today"],
      intentId: "intent:2",
      bound: true,
    },
  ])(
    "binds $intentId only to a declared intent ($row)",
    async ({ intents, intentId, bound }) => {
      const { run, provenance } = await replayStage1({
        text: "Say hi to Sam. Also is QA coffee today?",
        reply: STALE_QA,
        intents,
        bindings: [{ ...NEXT_EVENT, intentId }],
      });
      expect(run.parsed.calendarReadBindings).toEqual(
        bound ? [{ ...NEXT_EVENT, intentId, ...provenance }] : [],
      );
      expect(run.parsed.intents).toEqual(intents);
      expect(run.parsed.replyText).toBe(bound ? STALE_QA : "");
    },
  );
  it.each([
    {
      row: "R41 navigation",
      text: "Open my calendar for tomorrow",
      reply: "Here's your calendar for tomorrow.",
    },
    {
      row: "L9 time conversion",
      contexts: ["simple"],
      text: "What's 9 AM Pacific tomorrow in UTC?",
      reply: "Tomorrow at 9 AM Pacific is 5 PM UTC.",
    },
    {
      row: "B1 time conversion",
      text: "My meeting is at 3 PM Pacific. What time is that in London?",
      reply: "Your meeting is at 11 PM London time.",
    },
    {
      row: "R34 history quotation",
      text: "Quote your earlier answer about QA coffee.",
      reply: "I told you QA coffee is tomorrow at 9 AM.",
    },
    {
      row: "R2 social",
      text: "I have a big presentation tomorrow",
      reply: "Good luck with the presentation tomorrow!",
    },
    {
      row: "R27 advice",
      text: "My dentist appointment is at 3. How early should I leave?",
      reply: "For a 3 PM appointment, leave around 2:30.",
    },
    {
      row: "R12 negative constraint",
      text: "Don't book anything on Fridays",
      reply: "Okay, no meetings on Fridays.",
    },
    {
      row: "L14 create preview",
      status: "non_applied",
      text: "Add QA coffee tomorrow at 9 AM.",
      reply: "Here's the draft: QA coffee, tomorrow at 9 AM, 1 hour.",
    },
    {
      row: "L1 farewell, field omitted",
      contexts: ["simple"],
      text: "Bye!",
      reply: "See you tomorrow!",
      bindings: undefined,
    },
  ])(
    "leaves $row unbound and unchanged",
    async ({ contexts, text, reply, status, ...row }) => {
      const { run, trace, handler } = await replayStage1({
        text,
        reply,
        status,
        contexts: contexts ?? ["calendar"],
        bindings: "bindings" in row ? row.bindings : [],
      });
      expect(trace).toMatchObject({ parseOutcome: "ok", handled: true });
      expect(trace?.debug).toBeUndefined();
      expect(run.parsed.calendarReadBindings).toEqual([]);
      expect(run.parsed.intents).toEqual([]);
      expect(run.parsed.replyText).toBe(reply);
      expect(run.parsed.contexts).toEqual(contexts ?? ["calendar"]);
      expect(handler.plan.requiresTool).not.toBe(true);
      expect(handler.plan.candidateActions).toEqual([]);
    },
  );
});
