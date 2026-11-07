/** Replays live trajectory tj-4f3ec3c2630bb7 (Alpha Phone, 2026-10-29): the
 * user asked "What did you see in the current calendar results?". The recent
 * originals were inline without hN labels, so the only ID the prompt gave each
 * earlier request was its historical receipt's requestSourceEventId,
 * "history:<message id>": that request's exact prior-dialogue source event ID.
 * Stage 1 read it twice (the observation's request, then after the repair the
 * navigation's request); both were rejected as unknown and the turn ended in
 * "Something went wrong on my end". Bound event IDs now read as the offered
 * history:hN; unbound ones still fail closed. Recorded tool calls only; no
 * model is called. */
import {
  type Action,
  ChannelType,
  ContextRegistry,
  completionContextSources,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  ResponseHandlerFieldRegistry,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.ts";
import {
  HISTORY_RETENTION_EVALUATOR,
  historyRetentionEvaluator,
} from "../history-retention.ts";
import { resolveStage1SenderRole } from "./addressing.ts";
import { createV5MessageContextObject } from "./context-assembly.ts";
import {
  projectReviewedHistory,
  readHistoryContextRequests,
} from "./history-discovery.ts";
import { runV5MessageRuntimeStage1 } from "./pipeline.ts";

const agentId = "00000000-0000-4000-8000-000000000003" as UUID;
const userId = "00000000-0000-4000-8000-000000000002" as UUID;
const roomId = "00000000-0000-4000-8000-000000000004" as UUID;
const scope = `${agentId}:${roomId}:${userId}`;
const OPEN_CALENDAR = "Can you open the calendar?";
const EDIT_COFFEE = "New edit the drink coffee event to remove the extra E.";
const calendarSearch = {
  name: "CALENDAR_SEARCH_EVENTS",
  similes: [],
  description: "Search calendar events.",
  historicalObservationOperations: ["calendar.event.search"],
  validate: async () => true,
  handler: async () => undefined,
} as unknown as Action;

function userTurn(
  clientMessageId: string,
  text: string,
  createdAt: number,
  actionResults: unknown[],
): Memory {
  const id = conversationClientUserMemoryId(scope, clientMessageId);
  return {
    id,
    entityId: userId,
    agentId,
    roomId,
    createdAt,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.VOICE_DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId,
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({ userMessageId: id, actionResults }),
      },
    },
  };
}
function agentTurn(index: number, text: string, createdAt: number): Memory {
  return {
    id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}` as UUID,
    entityId: agentId,
    agentId,
    roomId,
    createdAt,
    content: { text, source: "client_chat" },
  };
}
const navigation = (viewId: string, label: string, step: number) => ({
  actionName: "VIEWS_SHOW",
  success: true,
  text: JSON.stringify({
    effect: "view_navigation",
    status: "prepared",
    viewId,
    path: `/${viewId}`,
    label,
    stepId: `step-${step}`,
    handoffId: `handoff-${step}`,
  }),
});
const calendarRead = normalizeEffectReceipt({
  receiptId: "calendar-feed-read-receipt-v1:1",
  operation: "calendar.event.search",
  resource: { kind: "calendar.feed", id: "feed", version: "v1" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-10-30T05:35:54.266Z",
  outcome: "noop",
  reason:
    "The operation read an authoritative calendar snapshot without changing it.",
});

const openCalendar = userTurn("open-calendar", OPEN_CALENDAR, 3_000, [
  navigation("calendar", "Calendar", 1),
]);
const editCoffee = userTurn("edit-coffee", EDIT_COFFEE, 5_000, [
  {
    actionName: calendarSearch.name,
    success: true,
    effectReceipts: [calendarRead],
  },
]);
// The live room had 33 sources; the continuity floor kept its last 10 (these
// turns) inline without hN labels and the review deferred the rest.
const earlier: Memory[] = Array.from({ length: 23 }, (_, i) =>
  i % 2
    ? agentTurn(100 + i, `reply ${i + 1}`, 100 + i)
    : userTurn(`earlier-${i}`, `message ${i + 1}`, 100 + i, []),
);
const prior: Memory[] = [
  ...earlier,
  userTurn("okay", "Okay.", 900, []),
  agentTurn(1, "taking you home.", 950),
  userTurn("hi", "hi", 1_000, []),
  agentTurn(2, "hey.", 2_000),
  openCalendar,
  agentTurn(4, "Opening Calendar.", 4_000),
  editCoffee,
  agentTurn(
    6,
    "I couldn’t find the coffee event in the current Calendar results, so I haven’t made the edit.",
    6_000,
  ),
  userTurn("go-home", "Can you go home?", 7_000, [
    navigation("chat", "Home", 2),
  ]),
  agentTurn(8, "taking you home.", 8_000),
];
const message: Memory = {
  ...userTurn(
    "current",
    "What did you see in the current calendar results?",
    9_000,
    [],
  ),
  content: {
    text: "What did you see in the current calendar results?",
    source: "client_chat",
    channelType: ChannelType.VOICE_DM,
  },
};
const state = (): State => ({
  values: {},
  text: "",
  data: {
    providers: { RECENT_MESSAGES: { data: { recentMessages: prior } } },
  },
});
const read = (contextRequests: string[], acknowledgment: string) => ({
  text: "",
  toolCalls: [
    { name: "READ_CONTEXT", arguments: { acknowledgment, contextRequests } },
  ],
});
const handle = (args: Record<string, unknown>) => ({
  text: "",
  toolCalls: [
    {
      name: "HANDLE_RESPONSE",
      arguments: {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        contextRequests: [],
        intents: [],
        replyText: "",
        replyEffectStatus: "none",
        facts: [],
        relationships: [],
        topics: [],
        addressedTo: [],
        emotion: "none",
        ...args,
      },
    },
  ],
});

async function fixture(responses: unknown[]) {
  const fields = new ResponseHandlerFieldRegistry();
  for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
    fields.register(field);
  const useModel = vi.fn(async () => {
    if (!responses.length) throw new Error("Unbounded model retry");
    return responses.shift();
  });
  const runtime = {
    agentId,
    character: { name: "Alpha", system: "Answer.", bio: "" },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "calendar", description: "Events, appointments and availability." },
    ]),
    actions: [calendarSearch],
    providers: [],
    evaluators: [historyRetentionEvaluator],
    getService: vi.fn(() => null),
    getRoom: vi.fn(async () => null),
    getModelRegistrations: vi.fn(() => []),
    getSetting: vi.fn(),
    getCache: vi.fn(),
    composeState: vi.fn(async () => state()),
    useModel,
    runActionsByMode: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    responseHandlerFieldRegistry: fields,
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    responseHandlerEvaluators: [],
  } as unknown as IAgentRuntime;
  const context = await createV5MessageContextObject({
    runtime,
    message,
    state: state(),
  });
  const reviewScope = {
    agentId,
    roomId,
    entityId: userId,
    roles: [await resolveStage1SenderRole(runtime, message)],
  };
  const prepared = prepareHistoryRetention(
    context,
    reviewScope,
    null,
    "evidence",
    prior.length,
  );
  const sourceIds = prepared.candidates.map((source) => source.id);
  // As live: a complete background review deferred the earlier originals.
  const progressState = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: sourceIds.slice(-1),
    deferSourceIds: sourceIds.slice(0, -1),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  vi.mocked(runtime.getCache).mockResolvedValue({
    scope: {
      agentId,
      roomId,
      entityId: userId,
      evaluatorName: HISTORY_RETENTION_EVALUATOR,
      version: 1,
    },
    completed: {},
    progressState,
  });
  const history = projectReviewedHistory(context, reviewScope, progressState);
  if (!history) throw new Error("Missing history projection");
  const run = () =>
    runV5MessageRuntimeStage1({
      runtime,
      state: state(),
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
  const prompt = (index: number) => JSON.stringify(useModel.mock.calls[index]);
  const sources = completionContextSources(context).sources;
  const hN = (memory: Memory) =>
    `history:${sources.find(({ event }) => event.id === `history:${memory.id}`)?.id}`;
  const readsResolved = () =>
    vi
      .mocked(runtime.logger.debug)
      .mock.calls.flatMap(([fields, text]) =>
        text ===
        "[message] Resolving context or routing before final response decision"
          ? [(fields as { providers: string[] }).providers]
          : [],
      );
  return { context, history, run, useModel, prompt, hN, readsResolved };
}

describe("historical receipt request IDs", () => {
  it("reads a bound request event ID as its offered history:hN only", async () => {
    const { context, history, hN } = await fixture([]);
    const bound = completionContextSources(context).sources;
    expect([hN(openCalendar), hN(editCoffee)]).toEqual([
      "history:h28",
      "history:h30",
    ]);
    const available = new Set([
      "history:all",
      ...bound.map(({ id }) => `history:${id}`),
    ]);
    expect(
      readHistoryContextRequests(
        context,
        history,
        {
          contextRequests: [
            `history:${editCoffee.id}`,
            hN(editCoffee),
            `history:${openCalendar.id}`,
          ],
        },
        available,
      ),
    ).toEqual([hN(editCoffee), hN(openCalendar)]);
    // Unbound message IDs, and any alias without the source-bound history
    // projection or its offered canonical read, still fail closed.
    const unbound = "history:4cf241e4-5f87-0bec-90a6-fcfa877f6d69";
    expect(() =>
      readHistoryContextRequests(
        context,
        history,
        { contextRequests: [`history:${editCoffee.id}`, unbound] },
        available,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_DISCOVERY_INVALID_REQUEST",
        context: { rejected: [unbound] },
      }),
    );
    for (const [projection, offered] of [
      [undefined, available],
      [history, new Set(["history:all"])],
    ] as const)
      expect(() =>
        readHistoryContextRequests(
          context,
          projection,
          { contextRequests: [`history:${editCoffee.id}`] },
          offered,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
      );
  });

  it("replays tj-4f3ec3c2630bb7: both recorded receipt-ID reads resolve and the turn decides", async () => {
    const f = await fixture([
      // Recorded call 1, then the call recorded after the repair.
      read([`history:${editCoffee.id}`], "Let me check."),
      read([`history:${openCalendar.id}`], "Yeah, I can check that."),
      handle({
        replyText:
          "I searched the calendar twice and found no coffee event, so nothing was edited.",
      }),
    ]);
    const result = await f.run();
    expect(result.kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(3);
    // The prompt printed exactly the IDs the model read, beside the unlabeled
    // inline originals and an hN-only history index.
    expect(f.prompt(0)).toContain("history:h1–history:h33");
    expect(f.prompt(0)).toContain(
      `\\"requestSourceEventId\\":\\"history:${editCoffee.id}\\"`,
    );
    expect(f.prompt(0)).toContain(
      `\\"requestSourceEventId\\":\\"history:${openCalendar.id}\\"`,
    );
    expect(f.prompt(0)).toContain(EDIT_COFFEE);
    expect(f.prompt(0)).not.toMatch(/\[h\d+[\];]/);
    // Each recorded read resolved to its offered canonical source read.
    expect(f.readsResolved()).toEqual([
      [f.hN(editCoffee)],
      [f.hN(openCalendar)],
    ]);
    for (const index of [1, 2]) {
      expect(f.prompt(index)).toContain("context_read_result");
      expect(f.prompt(index)).not.toContain("context_read_repair");
    }
  });
});
