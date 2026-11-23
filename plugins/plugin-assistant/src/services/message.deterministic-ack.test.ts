import type {
  AgentRuntime,
  HandlerCallback,
  Memory,
  ResponseHandlerEvaluator,
  UUID,
} from "@elizaos/core";
import {
  attestAuthenticatedApiDeliveryAudience,
  ChannelType,
  createCharacter,
  ModelType,
  TurnAbortedError,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../index.ts";
import {
  DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS,
  scheduleDelayedAcknowledgment,
} from "./message/delayed-acknowledgment.ts";
import { DefaultMessageService } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d3" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000d4" as UUID;

const runtimes: AgentRuntime[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ToolBehaviour = (tool: {
  events: string[];
  callback?: HandlerCallback;
  abort: () => void;
}) => Promise<void>;

/** One owner turn that Stage 1 routes straight to LOOKUP (no planner). */
async function deterministicTurn({
  acknowledgment = "Let me check your calendar.",
  tool,
  acknowledgmentMs = 0,
  replyMs = 0,
}: {
  acknowledgment?: string;
  tool: ToolBehaviour;
  acknowledgmentMs?: number;
  replyMs?: number;
}) {
  const controller = new AbortController();
  const events: string[] = [];
  let plannerCalls = 0;
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({
      id: AGENT_ID,
      name: "Deterministic ack",
      bio: "test",
      settings: {},
    }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  await runtime.createWorld({
    id: WORLD_ID,
    agentId: runtime.agentId,
    name: "Owner world",
    metadata: {
      ownership: { ownerId: OWNER_ID },
      roles: { [OWNER_ID]: "OWNER" },
    },
  });
  await runtime.ensureRoomExists({
    id: ROOM_ID,
    source: "client_chat",
    type: ChannelType.DM,
    worldId: WORLD_ID,
  });
  await runtime.addParticipant(OWNER_ID, ROOM_ID);
  await runtime.addParticipant(runtime.agentId, ROOM_ID);
  runtime.actions.length = 0;
  runtime.evaluators.length = 0;
  runtime.composeState = vi.fn(async () => ({
    values: { availableContexts: "general" },
    data: {},
    text: "",
  })) as AgentRuntime["composeState"];
  runtime.registerAction({
    name: "LOOKUP",
    description: "Looks up an entry.",
    parameters: [
      {
        name: "query",
        description: "Entry",
        required: true,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, _message, _state, _options, callback) => {
      events.push("tool-start");
      await tool({ events, callback, abort: () => controller.abort() });
      events.push("tool-end");
      return {
        success: true,
        text: "Nothing this week.",
        userFacingText: "Nothing this week.",
      };
    },
  });
  const route: ResponseHandlerEvaluator = {
    name: "test.deterministic-lookup",
    priority: 80,
    deterministicActions: ["LOOKUP"],
    shouldRun: ({ messageHandler }) =>
      messageHandler.processMessage === "RESPOND" &&
      !messageHandler.plan.deterministicToolCall,
    evaluate: () => ({
      requiresTool: true,
      clearReply: true,
      deterministicToolCall: {
        name: "LOOKUP",
        params: { query: "this week" },
      },
    }),
  };
  runtime.responseHandlerEvaluators = [route];
  let handlerCalls = 0;
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () =>
      handlerCalls++ === 0
        ? {
            text: "",
            toolCalls: [
              {
                id: "handle-response-1",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  thought: "Look it up.",
                  contexts: ["general"],
                  intents: ["look up entry"],
                  candidateActionNames: ["LOOKUP"],
                  replyText: acknowledgment,
                  replyEffectStatus: "pending",
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                  requiresTool: true,
                },
              },
            ],
            finishReason: "tool_calls",
          }
        : JSON.stringify({
            thought: "Covered.",
            success: true,
            decision: "FINISH",
            messageToUser: "Nothing this week.",
          }),
    "deterministic-ack",
    300,
  );
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async () => {
      plannerCalls++;
      return { text: "", thought: "", toolCalls: [] };
    },
    "deterministic-ack",
    300,
  );
  const message: Memory = {
    id: "00000000-0000-4000-8000-0000000000d5" as UUID,
    entityId: OWNER_ID,
    agentId: runtime.agentId,
    roomId: ROOM_ID,
    content: {
      text: "Look up this week.",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  };
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_api_token",
  } as never);
  const acknowledgments: string[] = [];
  try {
    await new DefaultMessageService().handleMessage(
      runtime,
      message,
      async (content) => {
        if (content.text) events.push(`reply:${content.text}`);
        await sleep(replyMs);
        return [];
      },
      {
        abortSignal: controller.signal,
        onPlanningAcknowledgment: async (text) => {
          events.push("ack-start");
          await sleep(acknowledgmentMs);
          acknowledgments.push(text);
          events.push("ack-end");
        },
      },
    );
  } catch (error) {
    if (
      !controller.signal.aborted ||
      !(
        error instanceof TurnAbortedError ||
        (error instanceof Error && error.name === "AbortError")
      )
    )
      throw error;
  }
  events.push("turn-end");
  // Nothing may arrive once the turn has returned.
  await sleep(DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS + 100);
  return { acknowledgments, events, plannerCalls };
}

const slowTool: ToolBehaviour = () =>
  sleep(DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS + 200);

describe("deterministic tool acknowledgments", () => {
  beforeEach(() => vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0"));
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      runtimes.splice(0).map(async (runtime) => {
        await runtime.stop();
        await runtime.close();
      }),
    );
  });

  it("acknowledges a slow call once, while it runs and before the reply", async () => {
    const result = await deterministicTurn({ tool: slowTool });
    expect(result.plannerCalls).toBe(0);
    expect(result.acknowledgments).toEqual(["Let me check your calendar."]);
    const ackEnd = result.events.indexOf("ack-end");
    expect(result.events.slice(0, ackEnd + 1)).toEqual([
      "tool-start",
      "ack-start",
      "ack-end",
    ]);
    expect(result.events.at(-1)).toBe("turn-end");
    expect(result.events.filter((event) => event === "ack-start")).toHaveLength(
      1,
    );
  });

  it("finishes delivering an in-flight acknowledgment before the reply", async () => {
    // The tool settles while the host is still delivering the acknowledgment.
    const result = await deterministicTurn({
      acknowledgmentMs: 300,
      tool: () => sleep(DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS + 50),
    });
    expect(result.acknowledgments).toEqual(["Let me check your calendar."]);
    const ackEnd = result.events.indexOf("ack-end");
    const firstReply = result.events.findIndex((event) =>
      event.startsWith("reply:"),
    );
    expect(result.events.indexOf("tool-end")).toBeLessThan(ackEnd);
    if (firstReply >= 0) expect(ackEnd).toBeLessThan(firstReply);
    expect(ackEnd).toBeLessThan(result.events.indexOf("turn-end"));
  });

  it("never acknowledges a call that settles within the delay", async () => {
    const result = await deterministicTurn({ tool: async () => {} });
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).not.toContain("ack-start");
    expect(result.events.slice(0, 2)).toEqual(["tool-start", "tool-end"]);
  });

  it("never acknowledges after the tool's own callback delivered text", async () => {
    // The callback's text is out within the delay; its slow delivery keeps
    // the call running past it.
    const result = await deterministicTurn({
      replyMs: DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS + 200,
      tool: async ({ callback }) => {
        await callback?.({ text: "Opening your calendar now." });
      },
    });
    expect(result.events).toContain("reply:Opening your calendar now.");
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).not.toContain("ack-start");
  });

  it("delivers a callback emitted during a slow call after its acknowledgment", async () => {
    // The executor buffers handler callbacks until the handler returns.
    const result = await deterministicTurn({
      tool: async ({ callback }) => {
        await callback?.({ text: "Opening your calendar now." });
        await slowTool({ events: [], abort: () => {} });
      },
    });
    expect(result.acknowledgments).toEqual(["Let me check your calendar."]);
    expect(result.events.indexOf("ack-end")).toBeLessThan(
      result.events.indexOf("reply:Opening your calendar now."),
    );
  });

  it("never acknowledges an aborted turn", async () => {
    const result = await deterministicTurn({
      tool: async ({ abort }) => {
        abort();
        await slowTool({ events: [], abort: () => {} });
      },
    });
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).not.toContain("ack-start");
  });

  it("never shows a draft that is not a claim-safe acknowledgment", async () => {
    const result = await deterministicTurn({
      acknowledgment: "Nothing on your calendar today.",
      tool: slowTool,
    });
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).not.toContain("ack-start");
  });
});

describe("scheduleDelayedAcknowledgment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends once the delay passes and settle awaits the delivery", async () => {
    const order: string[] = [];
    let finish: () => void = () => {};
    const delayed = scheduleDelayedAcknowledgment({
      delayMs: 400,
      send: () =>
        new Promise<void>((resolve) => {
          order.push("send-start");
          finish = () => {
            order.push("send-end");
            resolve();
          };
        }),
      onError: () => order.push("error"),
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["send-start"]);
    const settled = delayed.settle().then(() => order.push("settled"));
    await Promise.resolve();
    expect(order).toEqual(["send-start"]);
    finish();
    await settled;
    expect(order).toEqual(["send-start", "send-end", "settled"]);
  });

  it("never sends after settle or abort", async () => {
    const send = vi.fn();
    const settledEarly = scheduleDelayedAcknowledgment({
      delayMs: 400,
      send,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(399);
    await settledEarly.settle();
    const controller = new AbortController();
    scheduleDelayedAcknowledgment({
      delayMs: 400,
      send,
      abortSignal: controller.signal,
      onError: () => {},
    });
    controller.abort();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    scheduleDelayedAcknowledgment({
      delayMs: 400,
      send,
      abortSignal: alreadyAborted.signal,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed delivery instead of failing the settled work", async () => {
    const onError = vi.fn();
    const failure = new Error("status channel closed");
    const delayed = scheduleDelayedAcknowledgment({
      delayMs: 400,
      send: async () => {
        throw failure;
      },
      onError,
    });
    await vi.advanceTimersByTimeAsync(400);
    await expect(delayed.settle()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
