import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  EventType,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  detectLocalInferenceCommandIntent,
  generateChatResponse,
} from "../../src/api/chat-routes.js";
import { estimateTokenCount } from "../../src/runtime/prompt-optimization.js";

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

  it("fails closed when a model returns an unexecuted action payload", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Done, I sent the funds.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.text).toContain("SENSITIVE_ACTION");
    expect(result.text).not.toContain("sent the funds");
    expect(runtime.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "eliza-api",
        parsedActions: ["SENSITIVE_ACTION"],
      }),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("fails closed when only unrelated action callbacks fired", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ actions: ["SEARCHING"] });
          return {
            didRespond: true,
            responseContent: {
              text: "Done, I sent the funds.",
              actions: ["SENSITIVE_ACTION"],
            },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.text).toContain("SENSITIVE_ACTION");
    expect(result.text).not.toContain("sent the funds");
  });

  it("does not fail closed when core reports actions mode", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          mode: "actions",
          responseContent: {
            text: "Action completed by core.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
      { timeoutDuration: 5_000 },
    );

    expect(result.text).toBe("Action completed by core.");
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("does not fail closed when action result records an alias for the runtime action", async () => {
    const message = createChatMessage("send funds");
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION", similes: ["TRANSFER_FUNDS"] }],
      getActionResults: vi.fn(() => [{ actionName: "TRANSFER_FUNDS" }]),
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Action completed from recorded alias.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(runtime, message, "Chat Agent", {
      timeoutDuration: 5_000,
    });

    expect(result.text).toBe("Action completed from recorded alias.");
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("does not fail closed when runtime action results show execution", async () => {
    const message = createChatMessage("send funds");
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      getActionResults: vi.fn(() => [{ actionName: "SENSITIVE_ACTION" }]),
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Action completed from recorded result.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(runtime, message, "Chat Agent", {
      timeoutDuration: 5_000,
    });

    expect(result.text).toBe("Action completed from recorded result.");
    expect(runtime.getActionResults).toHaveBeenCalledWith(message.id);
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });
});

describe("local inference chat command intent detection", () => {
  it("detects flexible local model management phrasing", () => {
    expect(
      detectLocalInferenceCommandIntent("can you re-download the llama model?"),
    ).toBe("redownload");
    expect(
      detectLocalInferenceCommandIntent("switch to something smaller locally"),
    ).toBe("switch_smaller");
    expect(detectLocalInferenceCommandIntent("use cloud")).toBe("use_cloud");
    expect(
      detectLocalInferenceCommandIntent("how far is the model download?"),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent("local inference status please"),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent(
        "what model are you running locally right now?",
      ),
    ).toBe("status");
  });

  it("does not hijack ordinary chat without local inference context", () => {
    expect(detectLocalInferenceCommandIntent("download the report")).toBeNull();
    expect(detectLocalInferenceCommandIntent("retry that joke")).toBeNull();
    expect(
      detectLocalInferenceCommandIntent("what is your status?"),
    ).toBeNull();
  });

  it("allows short commands when the UI marks local inference context", () => {
    expect(
      detectLocalInferenceCommandIntent("status", {
        localInferenceContext: true,
      }),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent("download it", {
        localInferenceContext: true,
      }),
    ).toBe("download");
  });
});
