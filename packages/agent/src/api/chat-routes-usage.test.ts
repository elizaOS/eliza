import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  EventType,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { estimateTokenCount } from "../runtime/prompt-optimization.js";
import { generateChatResponse } from "./chat-routes.js";

type RuntimeOverrides = Partial<AgentRuntime> & {
  messageService?: NonNullable<AgentRuntime["messageService"]>;
};

function createRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const runtime = {
    agentId: stringToUuid("chat-agent"),
    character: {
      name: "Chat Agent",
      system: "System prompt",
      settings: {
        model: "test/chat-model",
      },
    },
    actions: [],
    plugins: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    ...overrides,
  } satisfies Partial<AgentRuntime>;

  return runtime as AgentRuntime;
}

function createChatMessage(text: string) {
  return createMessageMemory({
    id: stringToUuid(`message-${text}`),
    roomId: stringToUuid("room"),
    entityId: stringToUuid("user"),
    content: {
      text,
      channelType: ChannelType.DM,
    },
  });
}

describe("generateChatResponse usage reporting", () => {
  it("returns actual provider usage when a provider event is emitted", async () => {
    let runtime: AgentRuntime;
    runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => {
          await runtime.emitEvent(EventType.MODEL_USED, {
            runtime,
            source: "test-provider",
            provider: "test-provider",
            type: ModelType.TEXT_LARGE,
            tokens: {
              prompt: 42,
              completion: 11,
              total: 53,
            },
          });
          return {
            didRespond: true,
            responseContent: { text: "provider reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result.usage).toMatchObject({
      promptTokens: 42,
      completionTokens: 11,
      totalTokens: 53,
      provider: "test-provider",
      isEstimated: false,
      llmCalls: 1,
    });
  });

  it("marks route token counts as estimates when no provider event is emitted", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: { text: "estimated reply" },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });
    const message = createChatMessage("count this prompt");

    const result = await generateChatResponse(runtime, message, "Chat Agent", {
      timeoutDuration: 5_000,
    });

    expect(result.usage).toMatchObject({
      promptTokens: estimateTokenCount("count this prompt"),
      completionTokens: estimateTokenCount("estimated reply"),
      isEstimated: true,
      llmCalls: 0,
    });
  });

  it("marks visible action callbacks even when handlers only set actions", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ text: "callback reply", actions: ["REPLY"] });
          return {
            didRespond: true,
            responseContent: { actions: ["REPLY"], text: "callback reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result).toMatchObject({
      text: "callback reply",
      usedActionCallbacks: true,
      actionCallbackHistory: ["callback reply"],
    });
  });

  it("counts action-only callbacks without adding visible callback history", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ actions: ["SEARCHING"] });
          return {
            didRespond: true,
            responseContent: { text: "final reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result).toMatchObject({
      text: "final reply",
      usedActionCallbacks: true,
    });
    expect(result.actionCallbackHistory).toBeUndefined();
  });
});
