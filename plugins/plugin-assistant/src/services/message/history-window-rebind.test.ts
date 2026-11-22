/** Stage 1 binds its positional window to the exact sources it saw. The
 * planner's context is assembled afterwards, and one message landing or one
 * proposal ending in between gave it another source-set identity: the planner,
 * every later planner step and the evaluator then carried the whole room. In
 * a recorded 36-turn phone run that was 5 of 20 planner calls and 4 of 5
 * evaluator calls on windowed turns. */
import { ChannelType, type ContextEvent, type Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import { runEvaluator } from "../../runtime/evaluator.ts";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
  windowHistoryRetention,
} from "../../runtime/history-retention.ts";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { historyRetentionEvaluator } from "../history-retention.ts";
import {
  type HistoryDiscovery,
  projectBackgroundHistory,
  projectReviewedHistory,
  recallDeferredHistory,
  withBackgroundHistory,
} from "./history-discovery.ts";

const scope = {
  agentId: "agent",
  roomId: "room",
  entityId: "owner",
  roles: ["OWNER"],
};
const NOT_SHOWN =
  "40 earlier messages are not shown; they were deferred by position, not reviewed.";

function room(
  count: number,
  extra: ContextEvent[] = [],
  text: (index: number) => string = (index) => `original-${index}.`,
) {
  return {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    events: [
      ...Array.from(
        { length: count },
        (_, i): ContextEvent => ({
          id: `history:${i}`,
          type: "segment",
          source: "prior-dialogue",
          segment: {
            id: `history:${i}`,
            label: `prior_message:${i % 2 ? "agent" : "user"}`,
            content: text(i),
            stable: false,
            metadata: { roomId: "room", entityId: i % 2 ? "agent" : "owner" },
          },
        }),
      ),
      ...extra,
    ],
  };
}

/** The recorded outcome of one earlier request, as dialogue context stores it. */
const outcome = (request: number, state: string): ContextEvent => ({
  id: `historical-effects:${request}`,
  type: "segment",
  source: "message-service",
  segment: {
    id: `historical-effects:${request}`,
    label: "runtime:historical_effects",
    stable: false,
    content: JSON.stringify({
      requestSourceEventId: `history:${request}`,
      scope: "Past recorded outcomes only.",
      outcomes: [
        {
          actionName: "PROPOSE_DEVICE_ACTION",
          success: true,
          receipt: {
            receiptId: "receipt-1",
            operation: "device.phone_call",
            resource: { kind: "device.approval", id: "receipt-1" },
            artifacts: [],
            idempotency: { key: "device:key-1", replayed: false },
            observedAt: "2026-11-20T21:15:04.179Z",
            outcome: state,
          },
        },
      ],
    }),
  },
});

/** What Stage 1 hands the pipeline for a context it windowed by position. */
function stage1Window(context: ReturnType<typeof room>): HistoryDiscovery {
  const window = windowHistoryRetention(context, scope, null);
  const history = projectReviewedHistory(context, scope, window.checkpoint);
  if (!history || !window.windowed) throw new Error("no window");
  history.windowed = true;
  return history;
}

const shown = (context: { events: readonly ContextEvent[] }) =>
  context.events.filter((event) => event.source === "prior-dialogue").length;

/** The planner requests and the evaluator request for a planner context. The
 * planner replies at once, or first asks for the deferred history. */
async function requests(
  context: ReturnType<typeof withBackgroundHistory>,
  restoreFirst = false,
) {
  const planner: { messages: string; tools: string[] }[] = [];
  await runPlannerLoop({
    context,
    tools: [{ name: "READ", description: "Read a record" }],
    runtime: {
      useModel: async (
        _type: unknown,
        params: { messages: unknown; tools?: { name: string }[] },
      ) => {
        planner.push({
          messages: JSON.stringify(params.messages),
          tools: (params.tools ?? []).map((tool) => tool.name),
        });
        const call: Record<string, string> =
          restoreFirst && planner.length === 1
            ? { reason: "An earlier item.", scope: "history" }
            : { text: "Done.", eliza_turn_scope: "final" };
        return {
          text: "",
          toolCalls: [
            {
              id: "call",
              name: call.reason ? "RESTORE_CONTEXT" : "REPLY",
              arguments: call,
            },
          ],
        };
      },
    },
    executeToolCall: async () => ({ success: true, text: "Read." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "Replied.",
      messageToUser: "Done.",
    }),
  });
  const evaluator: string[] = [];
  await runEvaluator({
    context,
    trajectory: {
      context,
      modelBaseContext: context,
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    },
    runtime: {
      useModel: async (_type: unknown, params: unknown) => {
        evaluator.push(JSON.stringify(params));
        return JSON.stringify({
          thought: "Done",
          success: true,
          decision: "FINISH",
        });
      },
    },
    effects: { messageToUser: async () => {}, copyToClipboard: async () => {} },
  });
  return {
    planner: planner[0],
    later: planner.slice(1),
    evaluator: evaluator[0],
  };
}

it.each([
  ["one message lands", room(61), room(62), 22],
  [
    "one proposal ends",
    room(61, [outcome(58, "preview")]),
    room(61, [outcome(58, "applied")]),
    21,
  ],
])(
  "keeps Stage 1's window for the planner and the evaluator when %s in between",
  async (_label, stage1Context, plannerContext, inline) => {
    const history = stage1Window(stage1Context);
    const bound = withBackgroundHistory(plannerContext, history);
    expect(projectBackgroundHistory(bound)).toMatchObject({
      applied: true,
      windowed: true,
      omittedSourceCount: 40,
    });
    expect(shown(projectBackgroundHistory(bound).context)).toBe(inline);
    // The canonical context keeps every original for a restore.
    expect(shown(bound)).toBe(shown(plannerContext));

    const { planner, evaluator } = await requests(bound);
    for (const sent of [planner.messages, evaluator]) {
      expect(sent).toContain(NOT_SHOWN);
      expect(sent).not.toContain("original-0.");
      expect(sent).not.toContain("original-39.");
      expect(sent).toContain("original-40.");
      expect(sent).toContain("original-60.");
    }
    expect(planner.tools).toContain("RESTORE_CONTEXT");
    // Asking for the deferred messages still brings every original back.
    const [restored] = (await requests(bound, true)).later;
    expect(restored.messages).toContain("original-0.");
    expect(restored.messages).toContain("original-60.");
    expect(restored.messages).not.toContain(NOT_SHOWN);
  },
);

it("shows the planner what Stage 1 recalled for the request, and the message that landed", () => {
  const said = (index: number) =>
    index === 4
      ? "For future reference, my gate code is 4471#."
      : `original-${index}.`;
  const stage1Context = room(61, [], said);
  const history = recallDeferredHistory(
    stage1Context,
    stage1Window(stage1Context),
    "What's my gate code again?",
  );
  // The deferred statement and the reply that followed it.
  expect([...history.loadedSourceIds]).toEqual(["h5", "h6"]);
  const planner = projectBackgroundHistory(
    withBackgroundHistory(room(62, [], said), history),
  );
  expect(planner).toMatchObject({
    applied: true,
    windowed: true,
    omittedSourceCount: 38,
  });
  const sent = JSON.stringify(planner.context.events);
  expect(sent).toContain("4471#");
  expect(sent).toContain("original-5.");
  expect(sent).toContain("original-61.");
  expect(sent).not.toContain("original-3.");
});

it("takes a fresh window when the deferred messages themselves changed, and shows everything only when it cannot", async () => {
  const stage1Context = room(61);
  const history = stage1Window(stage1Context);
  // An earlier message was edited meanwhile: Stage 1's boundary no longer
  // describes these sources.
  const edited = (index: number) =>
    index === 3 ? "edited-3." : `original-${index}.`;
  const fresh = withBackgroundHistory(room(62, [], edited), history);
  expect(projectBackgroundHistory(fresh)).toMatchObject({
    applied: true,
    windowed: true,
    omittedSourceCount: 40,
  });
  const { planner } = await requests(fresh);
  expect(planner.messages).toContain(NOT_SHOWN);
  expect(planner.messages).not.toContain("edited-3.");
  expect(planner.tools).toContain("RESTORE_CONTEXT");

  // What Stage 1 loaded is known only by its position in the old sources, so
  // a turn that loaded something keeps every original rather than guess.
  const loaded = { ...history, loadedSourceIds: new Set(["h5"]) };
  const everything = room(62, [], edited);
  expect(withBackgroundHistory(everything, loaded)).toBe(everything);

  // Two messages with one id cannot be told apart, so nothing is deferred.
  const ambiguous = room(62);
  ambiguous.events.push(structuredClone(ambiguous.events[61]));
  expect(withBackgroundHistory(ambiguous, history)).toBe(ambiguous);
  const whole = await requests(ambiguous);
  expect(whole.planner.messages).toContain("original-0.");
  expect(whole.planner.messages).not.toContain(
    "earlier messages are not shown",
  );

  // A room that is short enough again is shown whole.
  const short = room(30);
  expect(withBackgroundHistory(short, history)).toBe(short);
});

it("leaves a reviewer's view bound to the exact sources it was projected on", () => {
  const reviewedContext = room(61);
  const prepared = prepareHistoryRetention(
    reviewedContext,
    scope,
    null,
    "evidence",
    50,
  );
  const checkpoint = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: ["h1"],
    deferSourceIds: prepared.candidates.slice(1).map((source) => source.id),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  const history = projectReviewedHistory(reviewedContext, scope, checkpoint);
  if (!history) throw new Error("no reviewed projection");
  expect(history.windowed).toBeUndefined();
  // The same sources carry the reviewed view, with no window flag.
  expect(
    withBackgroundHistory(reviewedContext, history).metadata,
  ).toStrictEqual({
    ...reviewedContext.metadata,
    backgroundHistory: {
      sourceSetId: history.sourceSetId,
      scope,
      checkpoint,
      loadedSourceIds: [],
    },
  });
  // Other sources keep every original, as before.
  for (const other of [room(62), room(61, [outcome(58, "applied")])] as const) {
    expect(withBackgroundHistory(other, history)).toBe(other);
    expect(projectBackgroundHistory(other).applied).toBe(false);
  }
});

afterEach(() => vi.unstubAllEnvs());

it("sends a phone's planner the window Stage 1 used when a message lands while Stage 1 runs", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const runtime = makeRuntime([
    stage1Response({
      contexts: ["general"],
      intents: ["answer the owner"],
      replyText: "",
    }),
    {
      text: "",
      toolCalls: [
        {
          id: "reply",
          name: "REPLY",
          arguments: { text: "Done.", eliza_turn_scope: "final" },
        },
      ],
    },
  ]);
  Object.assign(runtime, { evaluators: [historyRetentionEvaluator] });
  runtime.getCache = async () => undefined;
  const message = makeMessage({ channelType: ChannelType.DM, text: "hi" });
  message.createdAt = 1000;
  const rows = (count: number): Memory[] =>
    Array.from({ length: count }, (_, i) => ({
      ...message,
      id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, "0")}` as Memory["id"],
      createdAt: i + 1,
      entityId: i % 2 ? runtime.agentId : message.entityId,
      content: { ...message.content, text: `original-${i}.` },
    }));
  const stateWith = (count: number) => {
    const state = makeState();
    state.data.providers = {
      RECENT_MESSAGES: { data: { recentMessages: rows(count) } },
    };
    return state;
  };
  // Stage 1 reads the room as it was; every later composition has one more.
  runtime.composeState = vi.fn(async () => stateWith(61));
  await runStage1({ runtime, message, state: stateWith(60) });

  const [stage1, planner] = useModelCalls(runtime).map(
    (call) => call[1] as { messages: unknown; tools: { name: string }[] },
  );
  expect(JSON.stringify(stage1.messages)).toContain(
    "40 earlier messages and the recorded outcomes of their requests are not shown.",
  );
  const sent = JSON.stringify(planner.messages);
  expect(sent).toContain("original-60.");
  expect(sent).toContain(NOT_SHOWN);
  expect(sent).not.toContain("original-0.");
  expect(planner.tools.map((tool) => tool.name)).toContain("RESTORE_CONTEXT");
});
