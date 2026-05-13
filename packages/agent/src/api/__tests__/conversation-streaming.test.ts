/**
 * Token-by-token streaming wire test for `generateChatResponse`.
 *
 * Asserts the contract that the chat-routes generator forwards LLM token
 * deltas to the caller via `onChunk` and accumulates them into the final
 * text. This is the missing functional coverage for the streaming path
 * exercised by `POST /api/conversations/:id/messages/stream`.
 */
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { generateChatResponse } from "../chat-routes.js";

type RuntimeOverrides = Partial<AgentRuntime> & {
  messageService?: NonNullable<AgentRuntime["messageService"]>;
};

type MessageService = NonNullable<AgentRuntime["messageService"]>;

function createRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const runtime = {
    agentId: stringToUuid("streaming-agent"),
    character: {
      name: "Streaming Agent",
      system: "System prompt",
      settings: { model: "test/streaming-model" },
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
    content: { text, channelType: ChannelType.DM },
  });
}

function createStreamingMessageService(
  tokens: string[],
  delayMs: number,
): MessageService {
  return {
    async handleMessage(_runtime, _message, _callback, options) {
      for (const token of tokens) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await options?.onStreamChunk?.(token);
      }
      return {
        didRespond: true,
        responseContent: { text: tokens.join("") },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "streaming-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

describe("generateChatResponse token streaming", () => {
  it("forwards onStreamChunk deltas to caller onChunk in order", async () => {
    // Tokens chosen so no token's prefix matches the prior token's suffix —
    // mergeStreamingText would otherwise treat overlap as a snapshot revision
    // and rewrite the delta. These tokens form clean, non-overlapping
    // boundaries.
    const tokens = ["Once ", "upon ", "a ", "midnight ", "dreary."];

    const runtime = createRuntime({
      messageService: createStreamingMessageService(tokens, 1),
    });

    const chunks: string[] = [];
    const snapshots: string[] = [];

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hi"),
      "Streaming Agent",
      {
        timeoutDuration: 5_000,
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
        onSnapshot: (text) => {
          snapshots.push(text);
        },
      },
    );

    // The 5 deltas the fake provider emitted should each have produced
    // exactly one onChunk callback in arrival order.
    expect(chunks).toEqual(tokens);

    const expectedFinal = tokens.join("");
    // onChunk values are deltas (each token), not snapshots.
    expect(chunks.join("")).toBe(expectedFinal);
    for (const chunk of chunks) {
      // No chunk should equal the full accumulated text — that would mean
      // the route was forwarding snapshots when it should be forwarding
      // deltas.
      expect(chunk).not.toBe(expectedFinal);
    }

    // For pure delta streams, the route does not need to call onSnapshot —
    // it would only do so if a callback path replaced the buffer.
    expect(snapshots.length).toBe(0);

    // Final text returned to caller equals the concatenation of deltas.
    expect(result.text).toBe(expectedFinal);
    expect(result.agentName).toBe("Streaming Agent");
  });

  it("preserves responseText state across delayed chunks", async () => {
    const tokens = ["alpha", " beta", " gamma"];

    const runtime = createRuntime({
      messageService: createStreamingMessageService(tokens, 5),
    });

    let runningTotal = "";
    const result = await generateChatResponse(
      runtime,
      createChatMessage("repeat"),
      "Streaming Agent",
      {
        timeoutDuration: 5_000,
        onChunk: (chunk) => {
          runningTotal += chunk;
        },
      },
    );

    expect(runningTotal).toBe("alpha beta gamma");
    expect(result.text).toBe("alpha beta gamma");
  });
});
