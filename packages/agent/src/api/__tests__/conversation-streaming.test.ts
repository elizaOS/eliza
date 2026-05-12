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

describe("generateChatResponse token streaming", () => {
  it("forwards onStreamChunk deltas to caller onChunk in order", async () => {
    const tokens = ["Hel", "lo ", "the", "re", "."];

    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(
          async (
            _runtime: unknown,
            _message: unknown,
            _callback: unknown,
            options: unknown,
          ) => {
            const opts = options as {
              onStreamChunk?: (chunk: string) => Promise<void> | void;
            };
            for (const token of tokens) {
              // Tiny delay between deltas mimics provider streaming pacing.
              await new Promise((resolve) => setTimeout(resolve, 1));
              await opts.onStreamChunk?.(token);
            }
            return {
              didRespond: true,
              responseContent: { text: tokens.join("") },
              responseMessages: [],
            };
          },
        ),
      } as NonNullable<AgentRuntime["messageService"]>,
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

    // onChunk values are deltas (each token), not snapshots.
    expect(chunks.join("")).toBe("Hello there.");
    for (const chunk of chunks) {
      // No chunk should equal the full accumulated text — that would mean
      // the route was forwarding snapshots when it should be forwarding
      // deltas.
      expect(chunk).not.toBe("Hello there.");
    }

    // For pure delta streams, the route does not need to call onSnapshot —
    // it would only do so if a callback path replaced the buffer.
    expect(snapshots.length).toBe(0);

    // Final text returned to caller equals the concatenation of deltas.
    expect(result.text).toBe("Hello there.");
    expect(result.didRespond).toBe(true);
  });

  it("preserves responseText state across delayed chunks", async () => {
    const tokens = ["alpha", " beta", " gamma"];

    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(
          async (
            _runtime: unknown,
            _message: unknown,
            _callback: unknown,
            options: unknown,
          ) => {
            const opts = options as {
              onStreamChunk?: (chunk: string) => Promise<void> | void;
            };
            for (const token of tokens) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              await opts.onStreamChunk?.(token);
            }
            return {
              didRespond: true,
              responseContent: { text: tokens.join("") },
              responseMessages: [],
            };
          },
        ),
      } as NonNullable<AgentRuntime["messageService"]>,
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
