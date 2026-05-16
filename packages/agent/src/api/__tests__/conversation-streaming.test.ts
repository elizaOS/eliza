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
import {
  generateChatResponse,
  generateConversationTitle,
  markSyntheticChatFailureContent,
  normalizeChatResponseText,
} from "../chat-routes.js";

type RuntimeOverrides = Partial<AgentRuntime> & {
  messageService?: NonNullable<AgentRuntime["messageService"]>;
};

type MessageService = NonNullable<AgentRuntime["messageService"]>;
type UseModel = NonNullable<AgentRuntime["useModel"]>;
type UseModelMock = ReturnType<typeof vi.fn> & UseModel;

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

function createUseModelMock(
  impl: (modelType: unknown, params: unknown) => Promise<unknown>,
): UseModelMock {
  return vi.fn(impl) as unknown as UseModelMock;
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

  it("streams cleaned snapshots from the Android local direct path", async () => {
    const chunks: string[] = [];
    const snapshots: string[] = [];
    const useModel = createUseModelMock(async (_modelType, params) => {
      const textParams = params as {
        onStreamChunk?: (chunk: string) => Promise<void> | void;
      };
      await textParams.onStreamChunk?.("Yes");
      await textParams.onStreamChunk?.(", locally.");
      return "Yes, locally.";
    });
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
          ELIZA_MOBILE_LOCAL_DIRECT_REPLY: "1",
        };
        return values[key] ?? null;
      },
      useModel,
    });

    const message = createChatMessage("/no_think can you hear me locally?");
    message.content = {
      ...message.content,
      channelType: ChannelType.VOICE_DM,
    } as typeof message.content;

    const result = await generateChatResponse(
      runtime,
      message,
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

    const directParams = useModel.mock.calls[0]?.[1] as { prompt?: string };
    expect(directParams.prompt).not.toContain("/no_think");
    expect(directParams.prompt).toContain("can you hear me locally?");

    expect(useModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: true,
        maxTokens: 20,
        prompt: expect.stringContaining("<think>\n\n</think>\n"),
        providerOptions: expect.objectContaining({
          androidLocal: expect.objectContaining({
            minFirstSentenceChars: 12,
            stopOnFirstSentence: true,
          }),
          eliza: expect.objectContaining({
            thinking: "off",
          }),
        }),
        onStreamChunk: expect.any(Function),
      }),
    );
    expect(chunks).toEqual(["Yes", ", locally."]);
    expect(chunks.join("")).toBe("Yes, locally.");
    expect(snapshots).toEqual(["Yes", "Yes, locally."]);
    expect(result.text).toBe("Yes, locally.");
    expect(result.localInference).toEqual(
      expect.objectContaining({
        provider: "mobile-local-direct-reply",
        streamedChunks: 2,
      }),
    );
  });

  it("keeps contextual Android local turns on the normal message runtime", async () => {
    const useModel = createUseModelMock(async () => "generic local reply");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "You just told me your name is Ada." },
      responseMessages: [],
    }));
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
        };
        return values[key] ?? null;
      },
      useModel,
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "contextual-turn",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("what did I just say?"),
      "Streaming Agent",
      { timeoutDuration: 5_000 },
    );

    expect(useModel).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("You just told me your name is Ada.");
  });

  it("keeps tool-like Android local turns on the normal message runtime", async () => {
    const useModel = createUseModelMock(async () => "generic local reply");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "I need the normal runtime for that." },
      responseMessages: [],
    }));
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
        };
        return values[key] ?? null;
      },
      useModel,
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "tool-like-turn",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("remember that my favorite model is eliza"),
      "Streaming Agent",
      { timeoutDuration: 5_000 },
    );

    expect(useModel).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("I need the normal runtime for that.");
  });

  it("aborts the message runtime when the chat generation timeout fires", async () => {
    let signalFromOptions: AbortSignal | undefined;
    let observedAbort: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });

    const runtime = createRuntime({
      messageService: {
        async handleMessage(_runtime, _message, _callback, options) {
          signalFromOptions = options?.abortSignal;
          await new Promise<void>((resolve) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                observedAbort?.();
                resolve();
              },
              { once: true },
            );
          });
          return {
            didRespond: false,
            responseContent: null,
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
      },
    });

    await expect(
      generateChatResponse(
        runtime,
        createChatMessage("timeout"),
        "Streaming Agent",
        {
          timeoutDuration: 10,
        },
      ),
    ).rejects.toThrow("Chat generation timed out after 10ms");

    await abortObserved;
    expect(signalFromOptions?.aborted).toBe(true);
  });
});

describe("normalizeChatResponseText", () => {
  it("persists only replyText when response-handler payload text leaks through", () => {
    const leakedPayload =
      '"RESPOND", "contexts": ["simple"], "intents": ["hello"], "replyText": "Hello! How can I help you today?", "threadOps": [], "candidateActionNames": []';

    expect(normalizeChatResponseText(leakedPayload, [])).toBe(
      "Hello! How can I help you today?",
    );
  });

  it("persists only replyText when a boolean response-handler fragment leaks through", () => {
    const leakedPayload =
      'true,"contexts":["general"],"intents":["general"],"replyText":"Hello, how are you?"}';

    expect(normalizeChatResponseText(leakedPayload, [])).toBe(
      "Hello, how are you?",
    );
  });

  it("leaves normal assistant text unchanged", () => {
    expect(normalizeChatResponseText("Plain chat reply.", [])).toBe(
      "Plain chat reply.",
    );
  });

  it("marks synthetic failure replies so they do not become prompt context", () => {
    expect(
      markSyntheticChatFailureContent({
        text: "Sorry, I'm having a provider issue",
        source: "client_chat",
      }),
    ).toMatchObject({
      metadata: {
        elizaSyntheticFailure: true,
        chatFailureKind: "provider_issue",
      },
    });
  });
});

describe("generateConversationTitle", () => {
  it("passes caller cancellation into the title model request", async () => {
    const controller = new AbortController();
    let signalFromParams: AbortSignal | undefined;
    const runtime = createRuntime({
      useModel: vi.fn(
        async (
          _modelType: unknown,
          params: { signal?: AbortSignal },
        ): Promise<string> => {
          signalFromParams = params.signal;
          await new Promise((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => reject(params.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          });
          return "unused";
        },
      ) as unknown as AgentRuntime["useModel"],
    });

    const pending = generateConversationTitle(
      runtime,
      "Could you say hello?",
      "Streaming Agent",
      { signal: controller.signal, timeoutMs: 30_000 },
    );

    controller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(signalFromParams?.aborted).toBe(true);
  });
});
