/**
 * A host that defers history by position (a phone: no post-turn reviewer runs
 * there) offers Stage 1 the history read on every turn, with the same bytes
 * whether or not anything is deferred yet. Offered only once the window had
 * started, READ_CONTEXT changed the tool list on that turn; tool definitions
 * lead a provider's cached prefix, so the turn re-read its whole system
 * prompt and history uncached (turn 15 of each recorded 36-turn phone
 * conversation). A read that arrives while nothing is deferred is told so.
 */
import { ChannelType, type Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  addDeferredReference,
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import { HISTORY_WINDOW_MAX_SOURCES } from "../../runtime/history-retention.ts";
import { historyRetentionEvaluator } from "../history-retention.ts";
import { UNDEFERRED_HISTORY_READ_RESULT } from "./context-discovery.ts";

afterEach(() => vi.unstubAllEnvs());

type Tool = { name: string; parameters?: unknown };
const reply = () => stage1Response({ contexts: ["simple"], replyText: "hi" });
const read = (reads: unknown[]) => ({
  text: "",
  toolCalls: [
    { name: "READ_CONTEXT", arguments: { reads, acknowledgment: "" } },
  ],
});

/** One owner turn in a room that already holds `count` messages. */
function turn(
  responses: unknown[],
  count: number,
  options: { deferredProviders?: boolean } = {},
) {
  const runtime = makeRuntime(responses);
  Object.assign(runtime, { evaluators: [historyRetentionEvaluator] });
  runtime.getCache = async () => undefined;
  const message = makeMessage({ channelType: ChannelType.DM, text: "hi" });
  message.createdAt = 1000;
  const rows: Memory[] = Array.from({ length: count }, (_, i) => ({
    ...message,
    id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, "0")}` as Memory["id"],
    createdAt: i + 1,
    entityId: i % 2 ? runtime.agentId : message.entityId,
    content: { ...message.content, text: `original-${i}.` },
  }));
  const state = makeState();
  state.data.providers = {
    RECENT_MESSAGES: { data: { recentMessages: rows } },
  };
  if (options.deferredProviders) addDeferredReference(runtime, state);
  runtime.composeState = vi.fn(async () => structuredClone(state));
  return { runtime, message, state };
}
const sent = (runtime: ReturnType<typeof makeRuntime>, call = 0) =>
  useModelCalls(runtime)[call][1] as { tools: Tool[]; messages: unknown };

it.each([
  ["with nothing else to read", false],
  ["beside deferred provider references", true],
])(
  "sends the same Stage-1 tool bytes before and after the window starts, %s",
  async (_label, deferredProviders) => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const tools: Tool[][] = [];
    for (const count of [2, 14, HISTORY_WINDOW_MAX_SOURCES + 20]) {
      const { runtime, message, state } = turn([reply()], count, {
        deferredProviders,
      });
      await runStage1({ runtime, message, state });
      tools.push(sent(runtime).tools);
    }
    expect(tools[0].map((tool) => tool.name)).toEqual([
      "HANDLE_RESPONSE",
      "READ_CONTEXT",
    ]);
    // The history selectors are there whether or not anything is deferred.
    expect(JSON.stringify(tools[0][1])).toContain("history-search");
    expect(JSON.stringify(tools[1])).toBe(JSON.stringify(tools[0]));
    expect(JSON.stringify(tools[2])).toBe(JSON.stringify(tools[0]));
  },
);

it("leaves a host with a reviewer as it was: no read tool while nothing is deferred", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "");
  const { runtime, message, state } = turn([reply()], 2);
  await runStage1({ runtime, message, state });
  expect(sent(runtime).tools.map((tool) => tool.name)).toEqual([
    "HANDLE_RESPONSE",
  ]);
});

it.each([
  [
    "a search",
    { kind: "history-search", speaker: "all", query: "the gate code" },
  ],
  ["a message by position", { kind: "history-source", sourceOrdinals: [1] }],
  ["all history", { kind: "history-all" }],
])(
  "answers %s plainly when nothing is deferred, and the next call decides",
  async (_label, selector) => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const { runtime, message, state } = turn([read([selector]), reply()], 2);
    const onPlanningAcknowledgment = vi.fn();
    const result = await runStage1({
      runtime,
      message,
      state,
      onPlanningAcknowledgment,
    });
    expect(result.kind).toBe("direct_reply");
    expect(useModelCalls(runtime)).toHaveLength(2);
    const [first, second] = [sent(runtime, 0), sent(runtime, 1)];
    // Every message was already in the first request.
    expect(JSON.stringify(first.messages)).toContain("original-0.");
    expect(JSON.stringify(second.messages)).toContain(
      UNDEFERRED_HISTORY_READ_RESULT,
    );
    // It is not treated as a broken call, and it cannot be repeated.
    expect(JSON.stringify(second.messages)).not.toContain(
      "context_read_repair",
    );
    expect(second.tools.map((tool) => tool.name)).toEqual(["HANDLE_RESPONSE"]);
    expect(onPlanningAcknowledgment).not.toHaveBeenCalled();
  },
);

it("reads a deferred provider reference asked for beside a history selector", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const { runtime, message, state } = turn(
    [
      read([
        { kind: "provider", references: ["BOT_AWARENESS"] },
        { kind: "history-all" },
      ]),
      reply(),
    ],
    2,
    { deferredProviders: true },
  );
  await runStage1({ runtime, message, state });
  const second = JSON.stringify(sent(runtime, 1).messages);
  expect(second).toContain("Second private reference body.");
  expect(second).not.toContain("context_read_repair");
});
