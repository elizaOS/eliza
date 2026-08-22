/**
 * Token-by-token streaming wire test for `generateChatResponse`.
 *
 * Asserts the contract that the chat-routes generator forwards LLM token
 * deltas to the caller via `onChunk` and accumulates them into the final
 * text. This is the missing functional coverage for the streaming path
 * exercised by `POST /api/conversations/:id/messages/stream`.
 */

import type http from "node:http";
import {
  type Action,
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  INSUFFICIENT_CREDITS_REPLY,
  type Memory,
  RoomHandlerQueue,
  stringToUuid,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  __getChatDedupeTtlMsForTests,
  __resetChatDedupeForTests,
  chatEventsFromStructuredStreamPayload,
  classifyChatFailure,
  createChatTokenStreamWriter,
  DELTA_STREAM_PROTOCOL,
  detectLocalInferenceCommandIntent,
  generateChatResponse,
  generateConversationTitle,
  getChatFailureReply,
  getChatMessageIdFirstSeenAt,
  getRecentVisibleAssistantMemoryTextSince,
  hasRecentVisibleAssistantMemorySince,
  isDuplicateChatMessage,
  isLocalInferenceError,
  markSyntheticChatFailureContent,
  normalizeAccountConnectRequest,
  normalizeChatResponseText,
  normalizeClientMessageId,
  persistAssistantConversationMemory,
  readChatRequestPayload,
  releaseChatMessageId,
  resolveNoResponseFallback,
  writeChatStatusSse,
  writeChatTokenSse,
  writeChatToolSse,
  writeSse,
  writeSseData,
  writeSseJson,
} from "../chat-routes.js";

type RuntimeOverrides = Omit<Partial<AgentRuntime>, "useModel"> & {
  messageService?: NonNullable<AgentRuntime["messageService"]>;
  useModel?: UseModelMock | AgentRuntime["useModel"];
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
      level: "info",
      trace: vi.fn(),
      fatal: vi.fn(),
      success: vi.fn(),
      progress: vi.fn(),
      log: vi.fn(),
      clear: vi.fn(),
      child: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    roomHandlerQueue: new RoomHandlerQueue(),
    getMemories: vi.fn(async () => []),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    drainChatPreHandlers: vi.fn(async () => null),
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
  impl: (...args: Parameters<UseModel>) => Promise<unknown>,
): UseModelMock {
  const mock = vi.fn(async (...args: Parameters<UseModel>) => impl(...args));
  return mock as unknown as UseModelMock;
}

function createStreamingMessageService(tokens: string[]): MessageService {
  return {
    async handleMessage(_runtime, _message, _callback, options) {
      for (const token of tokens) {
        // Yield to the event loop between tokens (a real async boundary, as a
        // network stream would have) WITHOUT a wall-clock setTimeout, so the
        // ordering/accumulation assertions stay deterministic and never flake.
        await Promise.resolve();
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

function createWritableResponse() {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    headers: undefined as [number, Record<string, string>] | undefined,
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      res.headers = [status, headers];
    }),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  };
  return { res, writes };
}

describe("chat route helper coverage", () => {
  it("dedupes client message ids by scope and releases failed arrivals", () => {
    __resetChatDedupeForTests();
    const now = 1_000_000;
    const ttl = __getChatDedupeTtlMsForTests();

    expect(normalizeClientMessageId("  mobile-turn-1  ")).toBe("mobile-turn-1");
    expect(normalizeClientMessageId("")).toBeNull();
    expect(normalizeClientMessageId("x".repeat(129))).toBeNull();

    expect(isDuplicateChatMessage("room-a", "mobile-turn-1", now)).toBe(false);
    expect(getChatMessageIdFirstSeenAt("room-a", "mobile-turn-1")).toBe(now);
    expect(isDuplicateChatMessage("room-a", "mobile-turn-1", now + 1)).toBe(
      true,
    );
    expect(isDuplicateChatMessage("room-b", "mobile-turn-1", now + 2)).toBe(
      false,
    );

    releaseChatMessageId("room-a", "mobile-turn-1");
    expect(getChatMessageIdFirstSeenAt("room-a", "mobile-turn-1")).toBeNull();
    expect(
      isDuplicateChatMessage("room-a", "mobile-turn-1", now + ttl + 1),
    ).toBe(false);
  });

  it("maps structured tool stream payloads without leaking them as text", () => {
    expect(
      chatEventsFromStructuredStreamPayload({
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "SEARCH",
          arguments: '{"query":"local model"}',
        },
      }),
    ).toEqual({
      status: { kind: "running_tool", toolName: "SEARCH" },
      toolEvent: {
        phase: "call",
        callId: "call-1",
        toolName: "SEARCH",
        args: { query: "local model" },
      },
    });
    expect(
      chatEventsFromStructuredStreamPayload({
        type: "tool_error",
        toolCallId: "call-1",
        toolCall: { toolName: "SEARCH" },
        result: "offline",
      }),
    ).toEqual({
      toolEvent: {
        phase: "error",
        callId: "call-1",
        toolName: "SEARCH",
        error: "offline",
      },
    });
    expect(
      chatEventsFromStructuredStreamPayload({
        type: "tool_result",
        messageId: "call-2",
        toolCall: { action: "READ", result: { ok: true } },
      }),
    ).toEqual({
      toolEvent: {
        phase: "result",
        callId: "call-2",
        toolName: "READ",
        result: { ok: true },
      },
    });
    expect(
      chatEventsFromStructuredStreamPayload({ type: "evaluation" }),
    ).toEqual({ status: { kind: "evaluating" } });
    expect(
      chatEventsFromStructuredStreamPayload({ type: "context_event" }),
    ).toBeNull();
  });

  it("writes SSE frames for legacy and delta-v2 chat token protocols", () => {
    const legacy = createWritableResponse();
    writeSse(legacy.res as never, { type: "hello", text: "hi" });
    writeChatTokenSse(legacy.res as never, "Hi", "Hi");
    writeChatStatusSse(legacy.res as never, { kind: "streaming" });
    writeChatToolSse(legacy.res as never, {
      phase: "call",
      callId: "tool-1",
      toolName: "SEARCH",
    });
    writeSseData(legacy.res as never, "line one\nline two", "token.update");
    writeSseJson(legacy.res as never, { ok: true }, "json");

    expect(legacy.writes).toContain('data: {"type":"hello","text":"hi"}\n\n');
    expect(legacy.writes.join("")).toContain("event: token.update\n");
    expect(legacy.writes.join("")).toContain("data: line two\n");

    const deps = {
      writeChatTokenSse: vi.fn(),
      writeSse: vi.fn(),
    };
    const legacyWriter = createChatTokenStreamWriter("legacy", deps);
    legacyWriter.writeChunk(legacy.res as never, "A", "A");
    legacyWriter.writeSnapshot(legacy.res as never, "AB");
    expect(deps.writeChatTokenSse).toHaveBeenNthCalledWith(
      1,
      legacy.res,
      "A",
      "A",
      undefined,
    );
    expect(deps.writeChatTokenSse).toHaveBeenNthCalledWith(
      2,
      legacy.res,
      "AB",
      "AB",
      undefined,
    );

    const deltaDeps = {
      writeChatTokenSse: vi.fn(),
      writeSse: vi.fn(),
    };
    const deltaWriter = createChatTokenStreamWriter(
      DELTA_STREAM_PROTOCOL,
      deltaDeps,
    );
    deltaWriter.writeChunk(legacy.res as never, "a", "a");
    deltaWriter.writeChunk(legacy.res as never, "b".repeat(2048), "ab");
    deltaWriter.writeSnapshot(legacy.res as never, "abc");
    expect(deltaDeps.writeSse).toHaveBeenNthCalledWith(1, legacy.res, {
      type: "token",
      text: "a",
    });
    expect(deltaDeps.writeSse).toHaveBeenNthCalledWith(2, legacy.res, {
      type: "token",
      text: "b".repeat(2048),
      fullText: "ab",
    });
    expect(deltaDeps.writeSse).toHaveBeenNthCalledWith(3, legacy.res, {
      type: "token",
      fullText: "abc",
    });
  });

  it("parses chat request payloads with language, images, metadata, and stream negotiation", async () => {
    const req = {
      headers: { "x-eliza-ui-language": "fr-CA" },
    };
    const res = createWritableResponse().res;
    const error = vi.fn();
    // The helper contract is generic (<T extends object>), which a plain
    // vi.fn() value cannot satisfy structurally. Keep the mock non-generic
    // (raw untrusted JSON records) and expose it through a generic wrapper
    // whose single cast pins the caller-chosen T at the boundary.
    const readJsonBodyMock = vi.fn(
      async (
        _req: http.IncomingMessage,
        _res: http.ServerResponse,
        _options?: ReadJsonBodyOptions,
      ): Promise<Record<string, unknown> | null> => ({
        text: "  describe this image ",
        channelType: "voice_dm",
        images: [
          {
            data: "aGVsbG8=",
            mimeType: "IMAGE/JPEG",
            name: "image.jpg",
          },
        ],
        source: "mobile",
        metadata: { localInference: true },
        clientMessageId: " turn-7 ",
        streamProtocol: DELTA_STREAM_PROTOCOL,
      }),
    );
    const readJsonBody = <T extends object>(
      bodyReq: http.IncomingMessage,
      bodyRes: http.ServerResponse,
      options?: ReadJsonBodyOptions,
    ): Promise<T | null> =>
      readJsonBodyMock(bodyReq, bodyRes, options) as Promise<T | null>;

    const parsed = await readChatRequestPayload(req as never, res as never, {
      readJsonBody,
      error,
    });

    expect(parsed).toEqual({
      prompt: "describe this image",
      channelType: ChannelType.VOICE_DM,
      images: [
        {
          data: "aGVsbG8=",
          mimeType: "image/jpeg",
          name: "image.jpg",
        },
      ],
      preferredLanguage: "en",
      source: "mobile",
      metadata: { localInference: true },
      clientMessageId: "turn-7",
      streamProtocol: DELTA_STREAM_PROTOCOL,
    });
    expect(readJsonBodyMock).toHaveBeenCalledWith(req, res, {
      maxBytes: 20 * 1024 * 1024,
    });

    readJsonBodyMock.mockResolvedValueOnce({ text: "hi", channelType: "bad" });
    await expect(
      readChatRequestPayload(req as never, res as never, {
        readJsonBody,
        error,
      }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(res, "channelType is invalid", 400);

    error.mockClear();
    readJsonBodyMock.mockResolvedValueOnce({
      text: "hi",
      clientMessageId: "x".repeat(129),
    });
    await expect(
      readChatRequestPayload(req as never, res as never, {
        readJsonBody,
        error,
      }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      res,
      "clientMessageId must be a non-empty string of at most 128 characters",
      400,
    );

    readJsonBodyMock.mockResolvedValueOnce({ text: "   " });
    await expect(
      readChatRequestPayload(req as never, res as never, {
        readJsonBody,
        error,
      }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(res, "text is required");
  });

  it("classifies local inference commands and account-connect payloads", () => {
    expect(detectLocalInferenceCommandIntent("switch to cloud routing")).toBe(
      "use_cloud",
    );
    expect(
      detectLocalInferenceCommandIntent("what local model is loaded?", {
        localInferenceContext: true,
      }),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent("please use on-device inference"),
    ).toBe("use_local");
    expect(
      detectLocalInferenceCommandIntent("download the eliza-1 gguf model"),
    ).toBe("download");
    expect(detectLocalInferenceCommandIntent("cancel the gguf download")).toBe(
      "cancel",
    );
    expect(detectLocalInferenceCommandIntent("resume the gguf download")).toBe(
      "resume",
    );
    expect(detectLocalInferenceCommandIntent("retry gguf download")).toBe(
      "retry",
    );
    expect(
      detectLocalInferenceCommandIntent("switch to a smaller gguf model"),
    ).toBe("switch_smaller");
    expect(detectLocalInferenceCommandIntent("hello there")).toBeNull();

    expect(isLocalInferenceError(new Error("No local model is loaded"))).toBe(
      true,
    );
    expect(isLocalInferenceError("disk full while downloading gguf")).toBe(
      true,
    );
    expect(isLocalInferenceError(new Error("plain provider failure"))).toBe(
      false,
    );

    expect(
      normalizeAccountConnectRequest({
        providers: ["openai-api", "openai-api", "not-real"],
        reason: "  Need calendar access. ",
      }),
    ).toEqual({
      providers: ["openai-api"],
      reason: "Need calendar access.",
    });
    expect(
      normalizeAccountConnectRequest({ providers: ["not-real"] }),
    ).toBeUndefined();
  });

  it("marks synthetic chat failures and resolves visible fallback text", () => {
    const now = Date.now();
    const creditsLog = [
      {
        timestamp: now,
        level: "error",
        message: "Insufficient credits for provider",
      },
    ];
    expect(
      markSyntheticChatFailureContent<Content>({
        text: "Connect an LLM provider to start chatting. Open Settings → Providers, or choose Eliza Cloud during first-run setup.",
      }).metadata,
    ).toMatchObject({
      elizaSyntheticFailure: true,
      chatFailureKind: "no_provider",
    });
    expect(resolveNoResponseFallback(creditsLog as never)).toContain("credits");
    expect(
      normalizeChatResponseText(
        "I don't have a reply for that — try rephrasing?",
        creditsLog as never,
      ),
    ).toContain("credits");
    expect(
      getChatFailureReply(new Error("No provider registered for TEXT"), []),
    ).toContain("Connect an LLM provider");
    expect(
      getChatFailureReply(
        new Error("No handler found for delegate type: TEXT_LARGE"),
        [],
      ),
    ).toContain("Connect an LLM provider");
    expect(
      classifyChatFailure(
        new Error("No handler found for delegate type: REASONING_SMALL"),
        [],
      ),
    ).toBe("no_provider");
    expect(
      classifyChatFailure(
        new Error("No handler found for delegate type: TEXT_TO_SPEECH"),
        [],
      ),
    ).toBe("provider_issue");
    expect(
      classifyChatFailure(new Error("local inference unavailable"), []),
    ).toBe("local_inference");
  });

  it("uses provider-neutral credit copy for direct Cerebras and Eliza Cloud 402s", () => {
    const directCerebrasError = Object.assign(
      new Error("Cerebras API error: 402 Payment Required"),
      { statusCode: 402 },
    );
    const elizaCloudError = Object.assign(
      new Error("Insufficient credits. Required: $0.0014, Available: $0.0000"),
      {
        status: 402,
        error: { code: "insufficient_credits" },
      },
    );

    expect(getChatFailureReply(directCerebrasError, [])).toBe(
      INSUFFICIENT_CREDITS_REPLY,
    );
    expect(getChatFailureReply(elizaCloudError, [])).toBe(
      INSUFFICIENT_CREDITS_REPLY,
    );
    expect(INSUFFICIENT_CREDITS_REPLY).not.toMatch(
      /Eliza Cloud|cloud balance/i,
    );
  });

  it("persists assistant memory with source, channel, synthetic metadata, and dedupe", async () => {
    const roomId = stringToUuid("persist-room");
    const created: Memory[] = [];
    const runtime = createRuntime({
      // Mirrors AgentRuntime.createMemory, which resolves to the stored
      // memory's id.
      createMemory: vi.fn(async (memory: Memory) => {
        created.push(memory);
        return memory.id ?? stringToUuid(`created-${created.length}`);
      }),
      getMemories: vi.fn(async () => [
        createMessageMemory({
          id: stringToUuid("recent-assistant"),
          roomId,
          entityId: stringToUuid("streaming-agent"),
          content: { text: "Already persisted" },
        }),
      ]),
    });
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 12,
    });
    recent[0].createdAt = 2_000;
    (runtime.getMemories as ReturnType<typeof vi.fn>).mockResolvedValue(recent);

    await persistAssistantConversationMemory(
      runtime,
      roomId,
      {
        text: "Sorry, I'm having a provider issue",
        source: "direct",
      },
      ChannelType.VOICE_DM,
    );
    await persistAssistantConversationMemory(
      runtime,
      roomId,
      "Already persisted",
      ChannelType.DM,
      1_000,
    );

    expect(created).toHaveLength(1);
    expect(created[0].content).toMatchObject({
      text: "Sorry, I'm having a provider issue",
      source: "direct",
      channelType: ChannelType.VOICE_DM,
      metadata: {
        elizaSyntheticFailure: true,
        chatFailureKind: "provider_issue",
      },
    });
    await expect(
      hasRecentVisibleAssistantMemorySince(runtime, roomId, 1_000),
    ).resolves.toBe(true);
    await expect(
      getRecentVisibleAssistantMemoryTextSince(runtime, roomId, 1_000),
    ).resolves.toBe("Already persisted");
  });
});

describe("generateChatResponse token streaming", () => {
  it("forwards onStreamChunk deltas to caller onChunk in order", async () => {
    // Tokens chosen so no token's prefix matches the prior token's suffix —
    // mergeStreamingText would otherwise treat overlap as a snapshot revision
    // and rewrite the delta. These tokens form clean, non-overlapping
    // boundaries.
    const tokens = ["Once ", "upon ", "a ", "midnight ", "dreary."];
    const createLogs = vi.fn(async () => undefined);

    const runtime = createRuntime({
      messageService: createStreamingMessageService(tokens),
      createLogs,
    });

    const chunks: string[] = [];
    const snapshots: string[] = [];

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hi"),
      "Streaming Agent",
      {
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createLogs).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "inference_timing",
        body: expect.objectContaining({
          source: "inference_timing",
          metadata: expect.objectContaining({
            label: "chat-request",
            timeToFirstVisibleMs: expect.any(Number),
            timeToResponseFinalizedMs: expect.any(Number),
          }),
        }),
      }),
    ]);
  });

  it("preserves responseText state across delayed chunks", async () => {
    const tokens = ["alpha", " beta", " gamma"];

    const runtime = createRuntime({
      messageService: createStreamingMessageService(tokens),
    });

    let runningTotal = "";
    const result = await generateChatResponse(
      runtime,
      createChatMessage("repeat"),
      "Streaming Agent",
      {
        onChunk: (chunk) => {
          runningTotal += chunk;
        },
      },
    );

    expect(runningTotal).toBe("alpha beta gamma");
    expect(result.text).toBe("alpha beta gamma");
  });

  it("does not stream internal tool or evaluation payloads as visible chat text", async () => {
    const internalToolPayload = JSON.stringify({
      type: "tool_call",
      toolCall: {
        id: "tool-1",
        name: "VIEWS",
        arguments: { action: "show", view: "notes" },
        status: "pending",
      },
      contextEvent: {
        id: "tool:VIEWS",
        type: "tool",
        source: "message-service",
      },
    });
    const internalEvaluationPayload = JSON.stringify({
      type: "evaluation",
      evaluation: {
        success: true,
        decision: "FINISH",
        thought: "Opened the Notes view successfully.",
      },
    });
    const service: MessageService = {
      async handleMessage(_runtime, _message, _callback, options) {
        await options?.onStreamChunk?.(internalToolPayload);
        await options?.onStreamChunk?.(internalEvaluationPayload);
        return {
          didRespond: true,
          responseContent: { text: "Navigated to Notes (gui)." },
          responseMessages: [],
        };
      },
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "tool-stream-test",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    };
    const runtime = createRuntime({ messageService: service });

    const chunks: string[] = [];
    const snapshots: string[] = [];
    const result = await generateChatResponse(
      runtime,
      createChatMessage("open notes"),
      "Streaming Agent",
      {
        onChunk: (chunk) => chunks.push(chunk),
        onSnapshot: (text) => snapshots.push(text),
      },
    );

    expect(chunks).toEqual([]);
    expect(snapshots).toEqual(["Navigated to Notes (gui)."]);
    expect(result.text).toBe("Navigated to Notes (gui).");
  });

  it("keeps a visible action callback visible when its terminal receipt is internal", async () => {
    const text = "Opened Notes.";
    const service: MessageService = {
      async handleMessage(_runtime, _message, callback) {
        await callback?.({ text }, "VIEWS");
        return {
          didRespond: true,
          responseContent: { text, transcriptVisibility: "internal" as const },
          responseMessages: [],
          mode: "actions" as const,
          actionResults: [
            {
              success: true,
              text,
              transcriptVisibility: "internal" as const,
              data: { actionName: "VIEWS" },
            },
          ],
        };
      },
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "visible-callback-internal-receipt-test",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    };
    const runtime = createRuntime({ messageService: service });
    const chunks: string[] = [];
    const snapshots: string[] = [];

    const result = await generateChatResponse(
      runtime,
      createChatMessage("open notes"),
      "Streaming Agent",
      {
        onChunk: (chunk) => chunks.push(chunk),
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    );

    expect(chunks).toEqual([]);
    expect(snapshots).toEqual([text]);
    expect(result.text).toBe(text);
    expect(result.transcriptVisibility).toBeUndefined();
  });

  // Voice double-speak fix: the PERSONALITY-style turn delivers TWO texts
  // through the same HandlerCallback — the action's own ack (with actionName)
  // and the reply handler's terminal delivery (no actionName). The ack must be
  // emitted with origin "action_callback" (→ provisional wire frames a voice
  // client holds) and the reply with origin "model"; the returned final text
  // is the reply only.
  it("marks the action ack as action_callback origin and the reply delivery as model origin", async () => {
    const ack = "Set tone=warm for you.";
    const reply = "okay i changed personality to warm";
    const service: MessageService = {
      async handleMessage(_runtime, _message, callback) {
        // The action's own callback — provisional status text.
        await callback?.(
          { text: ack, actions: ["PERSONALITY"] },
          "PERSONALITY",
        );
        // The reply handler's terminal delivery (mode "simple") — the turn's
        // actual reply, delivered with no actionName.
        await callback?.({ text: reply });
        return {
          didRespond: true,
          responseContent: { text: reply },
          responseMessages: [],
        };
      },
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "double-speak-origin-test",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    };
    const runtime = createRuntime({ messageService: service });

    const chunks: Array<{ text: string; origin?: string }> = [];
    const snapshots: Array<{ text: string; origin?: string }> = [];
    const result = await generateChatResponse(
      runtime,
      createChatMessage("change your personality to warm"),
      "Streaming Agent",
      {
        onChunk: (chunk, origin) => chunks.push({ text: chunk, origin }),
        onSnapshot: (text, origin) => snapshots.push({ text, origin }),
      },
    );

    expect(chunks).toEqual([]);
    expect(snapshots).toEqual([
      { text: ack, origin: "action_callback" },
      { text: reply, origin: "model" },
    ]);
    // The reply wins the turn's final text — exactly one final message.
    expect(result.text).toBe(reply);
  });

  it("uses authoritative accumulated text for an in-place stream revision", async () => {
    const service: MessageService = {
      async handleMessage(_runtime, _message, _callback, options) {
        await Promise.resolve();
        await options?.onStreamChunk?.("helo world", undefined, "helo world");
        await Promise.resolve();
        await options?.onStreamChunk?.("l", undefined, "hello world");
        return {
          didRespond: true,
          responseContent: { text: "hello world" },
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

    const runtime = createRuntime({ messageService: service });

    const chunks: string[] = [];
    const snapshots: string[] = [];
    const result = await generateChatResponse(
      runtime,
      createChatMessage("typo"),
      "Streaming Agent",
      {
        onChunk: (chunk) => chunks.push(chunk),
        onSnapshot: (text) => snapshots.push(text),
      },
    );

    // First emission appended as a delta; the revision replaced via snapshot.
    expect(chunks).toEqual(["helo world"]);
    expect(snapshots).toEqual(["hello world"]);
    // The corrected text is what the caller ends up with — no "helo" garble.
    expect(result.text).toBe("hello world");
  });

  it("uses authoritative accumulated text so repeated characters survive chunk boundaries", async () => {
    const first = "runtime message lo";
    const complete = "runtime message loop, HTTP SSE";
    const service: MessageService = {
      async handleMessage(_runtime, _message, _callback, options) {
        await options?.onStreamChunk?.(first, undefined, first);
        await options?.onStreamChunk?.("op, HTTP SSE", undefined, complete);
        return {
          didRespond: true,
          responseContent: { text: complete },
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
    const runtime = createRuntime({ messageService: service });
    const chunks: string[] = [];
    const snapshots: string[] = [];

    const result = await generateChatResponse(
      runtime,
      createChatMessage("preserve repeated characters"),
      "Streaming Agent",
      {
        onChunk: (chunk) => chunks.push(chunk),
        onSnapshot: (text) => snapshots.push(text),
      },
    );

    expect(chunks.join("")).toBe(complete);
    expect(snapshots).toEqual([]);
    expect(result.text).toBe(complete);
  });

  it("preserves whitespace and repeated prefixes across genuine stream deltas", async () => {
    const deltas = ["Fast ", "streaming ", "stays ", "smooth."];
    const service: MessageService = {
      async handleMessage(_runtime, _message, _callback, options) {
        let accumulated = "";
        for (const delta of deltas) {
          accumulated += delta;
          await options?.onStreamChunk?.(delta, undefined, accumulated);
        }
        return {
          didRespond: true,
          responseContent: { text: accumulated },
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
    const runtime = createRuntime({ messageService: service });
    const chunks: string[] = [];

    const result = await generateChatResponse(
      runtime,
      createChatMessage("preserve token boundaries"),
      "Streaming Agent",
      {
        onChunk: (chunk) => chunks.push(chunk),
      },
    );

    expect(chunks).toEqual(deltas);
    expect(result.text).toBe("Fast streaming stays smooth.");
  });

  it("returns sanitized action result summaries for UI handoffs", async () => {
    const message = createChatMessage("create a workflow");
    const getActionResults = vi.fn(() => [
      {
        success: true,
        text: "Created workflow.",
        values: {
          workflowId: "workflow-1",
          workflowName: "Daily summary",
          longText: "x".repeat(1200),
        },
        data: {
          actionName: "WORKFLOW",
          workflow: { nodes: [{ id: "large-node" }] },
        },
      },
    ]);
    const runtime = createRuntime({
      getActionResults: getActionResults as AgentRuntime["getActionResults"],
      messageService: createStreamingMessageService(["Created workflow."]),
    });

    const result = await generateChatResponse(
      runtime,
      message,
      "Streaming Agent",
    );

    expect(getActionResults).toHaveBeenCalledWith(message.id);
    expect(result.actionResults).toEqual([
      {
        actionName: "WORKFLOW",
        success: true,
        text: "Created workflow.",
        values: {
          workflowId: "workflow-1",
          workflowName: "Daily summary",
          longText: `${"x".repeat(997)}...`,
        },
      },
    ]);
  });

  it("returns direct shortcut action results without relying on planner cache", async () => {
    const message = createChatMessage("open settings");
    const getActionResults = vi.fn(() => [
      {
        success: true,
        text: "Unrelated cached result.",
        data: { actionName: "WORKFLOW" },
      },
    ]);
    const runtime = createRuntime({
      getActionResults: getActionResults as AgentRuntime["getActionResults"],
      messageService: {
        ...createStreamingMessageService(["Navigated to Settings."]),
        async handleMessage() {
          return {
            didRespond: true,
            responseContent: { text: "Navigated to Settings." },
            responseMessages: [],
            actionResults: [
              {
                success: true,
                text: "Navigated to Settings.",
                values: { mode: "show", viewId: "settings", viewType: "gui" },
                data: { actionName: "VIEWS" },
              },
            ],
          };
        },
      },
    });

    const result = await generateChatResponse(
      runtime,
      message,
      "Streaming Agent",
    );

    expect(result.actionResults).toEqual([
      {
        actionName: "VIEWS",
        success: true,
        text: "Navigated to Settings.",
        values: { mode: "show", viewId: "settings", viewType: "gui" },
      },
    ]);
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
    expect(directParams.prompt).toContain("<start_of_turn>user\n");
    expect(directParams.prompt).toContain("<end_of_turn>\n");
    expect(directParams.prompt).toContain("<start_of_turn>model\n");
    expect(directParams.prompt).not.toContain("<|im_start|>");

    expect(useModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: true,
        maxTokens: 128,
        prompt: expect.stringContaining("<think>\n\n</think>\n"),
        stopSequences: ["<end_of_turn>", "<start_of_turn>"],
        providerOptions: expect.objectContaining({
          androidLocal: expect.objectContaining({
            minFirstSentenceChars: 12,
            stopOnFirstSentence: false,
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

  it("keeps device-bridge chat on the full host runtime without explicit local-reply opt-in", async () => {
    const messageService = createStreamingMessageService([
      "Host planner reply.",
    ]);
    const handleMessage = vi.spyOn(messageService, "handleMessage");
    const useModel = createUseModelMock(async () => "Unexpected local reply.");
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_DEVICE_BRIDGE_ENABLED: "1",
        };
        return values[key] ?? null;
      },
      messageService,
      useModel,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello from the phone"),
      "Streaming Agent",
    );

    expect(handleMessage).toHaveBeenCalledOnce();
    expect(useModel).not.toHaveBeenCalled();
    expect(result.text).toBe("Host planner reply.");
    expect(result.localInference).toBeUndefined();
  });

  it("finalizes an Android local result that wins the cancellation race", async () => {
    const caller = new AbortController();
    const useModel = createUseModelMock(async () => {
      caller.abort(new DOMException("socket closed", "AbortError"));
      return "Local reply completed.";
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

    const result = await generateChatResponse(
      runtime,
      createChatMessage("answer locally"),
      "Streaming Agent",
      { abortSignal: caller.signal },
    );

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Local reply completed.");
    expect(result.localInference?.provider).toBe("mobile-local-direct-reply");
  });

  it("includes complete recent-message history and preserves multi-sentence replies", async () => {
    const roomId = stringToUuid("room");
    const memories = Array.from({ length: 8 }, (_, index) => {
      const memory = createMessageMemory({
        id: stringToUuid(`history-${index}`),
        roomId,
        entityId:
          index % 2 === 0
            ? stringToUuid("user")
            : stringToUuid("streaming-agent"),
        content: { text: `${index}:${"x".repeat(750)}` },
      });
      memory.createdAt = index + 1;
      return memory;
    });
    const useModel = createUseModelMock(
      async () =>
        "First useful sentence. Second useful sentence. Third useful sentence.",
    );
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
          ELIZA_MOBILE_LOCAL_DIRECT_REPLY: "1",
        };
        return values[key] ?? null;
      },
      getMemories: vi.fn(async () => memories),
      useModel,
    });

    const message = createChatMessage("what happened next?");
    const result = await generateChatResponse(
      runtime,
      message,
      "Streaming Agent",
      {},
    );

    const params = useModel.mock.calls[0]?.[1] as {
      prompt: string;
      providerOptions: { androidLocal: { stopOnFirstSentence: boolean } };
    };
    expect(runtime.getMemories).toHaveBeenCalledWith({
      roomId,
      tableName: "messages",
      includeEmbedding: false,
    });
    for (let index = 0; index < 8; index += 1) {
      expect(params.prompt).toContain(`${index}:${"x".repeat(750)}`);
    }
    expect(params.prompt).toContain("Recent conversation (oldest to newest):");
    expect(params.prompt).toContain(
      "Answer in 1-3 concise, natural spoken sentences.",
    );
    expect(params.providerOptions.androidLocal.stopOnFirstSentence).toBe(false);
    expect(result.text).toBe(
      "First useful sentence. Second useful sentence. Third useful sentence.",
    );
  });

  it("reports history failures before falling back to the normal runtime", async () => {
    const historyError = new Error("message store unavailable");
    const useModel = createUseModelMock(async () => "contextless reply");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "Reply from the normal runtime." },
      responseMessages: [],
    }));
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
          ELIZA_MOBILE_LOCAL_DIRECT_REPLY: "1",
        };
        return values[key] ?? null;
      },
      getMemories: vi.fn(async () => {
        throw historyError;
      }),
      useModel,
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "history-fallback",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });
    const message = createChatMessage("what happened next?");

    const result = await generateChatResponse(
      runtime,
      message,
      "Streaming Agent",
    );

    expect(runtime.reportError).toHaveBeenCalledWith(
      "AndroidLocalDirectChat.history",
      historyError,
      { roomId: message.roomId, messageId: message.id },
    );
    expect(useModel).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Reply from the normal runtime.");
  });

  it("keeps tool-like and overlong Android local turns on the normal runtime", async () => {
    const useModel = createUseModelMock(async () => "direct local reply");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "Handled by normal runtime." },
      responseMessages: [],
    }));
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
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "blocked-direct-turn",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const withAttachment = createChatMessage("summarize this file locally");
    withAttachment.content = {
      ...withAttachment.content,
      attachments: [{ id: "file-1", url: "memory://file-1" }],
    } as typeof withAttachment.content;
    const overlong = createChatMessage("x".repeat(701));

    await generateChatResponse(runtime, withAttachment, "Streaming Agent", {});
    const result = await generateChatResponse(
      runtime,
      overlong,
      "Streaming Agent",
    );

    expect(useModel).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Handled by normal runtime.");
  });

  it("only answers current-data Android questions directly when the device is the subject", async () => {
    const useModel = createUseModelMock(async () => "Yes, local Eliza-1.");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "The normal runtime handled live data." },
      responseMessages: [],
    }));
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
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "current-data",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const weather = await generateChatResponse(
      runtime,
      createChatMessage("what is the weather today?"),
      "Streaming Agent",
    );
    const local = await generateChatResponse(
      runtime,
      createChatMessage("are you running locally on this device today?"),
      "Streaming Agent",
    );

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(weather.text).toBe("The normal runtime handled live data.");
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(local.text).toBe("Yes, local Eliza-1.");
  });

  it("sanitizes Android local prompt tokens and model response wrappers", async () => {
    const useModel = createUseModelMock(async () => ({
      content: [
        { text: "<think>hidden</think>\nmodel: First reply. " },
        { text: "Second reply.<end_of_turn>ignored" },
      ],
    }));
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "android",
          ELIZA_LOCAL_LLAMA: "1",
          ELIZA_MOBILE_LOCAL_DIRECT_REPLY: "1",
        };
        return values[key] ?? null;
      },
      getMemories: vi.fn(async () => [
        createMessageMemory({
          id: stringToUuid("history-token-test"),
          roomId: stringToUuid("room"),
          entityId: stringToUuid("user"),
          content: {
            text: "Please do not leak <start_of_turn> or <think> tags.",
          },
        }),
      ]),
      useModel,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("say <end_of_turn> safely"),
      "Streaming Agent",
    );

    const params = useModel.mock.calls[0]?.[1] as { prompt: string };
    expect(params.prompt).toContain("< start_of_turn >");
    expect(params.prompt).toContain("< think >");
    expect(params.prompt).toContain("say < end_of_turn > safely");
    expect(result.text).toBe("First reply. Second reply.");
  });

  it("uses the local direct path for iOS full Bun local backend", async () => {
    const useModel = createUseModelMock(async () => "Yes, on device.");
    const runtime = createRuntime({
      getSetting: (key: string) => {
        const values: Record<string, string> = {
          ELIZA_MOBILE_PLATFORM: "ios",
          ELIZA_IOS_LOCAL_BACKEND: "1",
          ELIZA_MOBILE_LOCAL_DIRECT_REPLY: "1",
        };
        return values[key] ?? null;
      },
      useModel,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("can you answer locally?"),
      "Streaming Agent",
    );

    expect(useModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: true,
        prompt: expect.stringContaining("can you answer locally?"),
      }),
    );
    expect(result.text).toBe("Yes, on device.");
    expect(result.localInference).toEqual(
      expect.objectContaining({
        provider: "mobile-local-direct-reply",
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
    );

    expect(useModel).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("I need the normal runtime for that.");
  });

  it("propagates caller cancellation into the message runtime", async () => {
    let signalFromOptions: AbortSignal | undefined;
    let runtimeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });

    const runtime = createRuntime({
      messageService: {
        async handleMessage(_runtime, _message, _callback, options) {
          signalFromOptions = options?.abortSignal;
          runtimeStarted?.();
          await new Promise<void>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                reject(options.abortSignal?.reason);
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

    const caller = new AbortController();
    const generation = generateChatResponse(
      runtime,
      createChatMessage("cancel this request"),
      "Streaming Agent",
      { abortSignal: caller.signal },
    );
    await started;
    caller.abort(new DOMException("Client disconnected", "AbortError"));

    await expect(generation).rejects.toThrow("Client disconnected");
    expect(signalFromOptions?.aborted).toBe(true);
  });

  it("finalizes a message result that wins the race with caller cancellation", async () => {
    const caller = new AbortController();
    const chunks: string[] = [];
    const handleMessage = vi.fn(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: {
          onStreamChunk?: (chunk: string) => Promise<void> | void;
        },
      ) => {
        await options?.onStreamChunk?.("completed reply");
        caller.abort(new DOMException("socket closed", "AbortError"));
        return {
          didRespond: true,
          responseContent: { text: "completed reply" },
          responseMessages: [],
        };
      },
    );
    const runtime = createRuntime({
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "streaming-test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("finish this request"),
      "Streaming Agent",
      {
        abortSignal: caller.signal,
        onChunk: (chunk) => chunks.push(chunk),
      },
    );

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["completed reply"]);
    expect(result.text).toBe("completed reply");
  });

  it("fails closed instead of starting fallback actions after cancellation", async () => {
    const caller = new AbortController();
    const fallbackHandler = vi.fn(async () => ({
      success: true,
      text: "Block started.",
    }));
    const useModel = createUseModelMock(async () =>
      JSON.stringify({ response: "I started the block." }),
    );
    const runtime = createRuntime({
      actions: [
        {
          name: "BLOCK",
          description: "Start a website block.",
          similes: [],
          examples: [],
          validate: async () => true,
          handler: fallbackHandler,
        } satisfies Action,
      ],
      useModel,
      messageService: {
        handleMessage: vi.fn(async () => {
          caller.abort(new DOMException("socket closed", "AbortError"));
          return {
            didRespond: true,
            responseContent: {
              text: "Starting the block now.",
              actions: ["BLOCK"],
            },
            responseMessages: [],
          };
        }),
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "streaming-test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("block distractions"),
      "Streaming Agent",
      { abortSignal: caller.signal },
    );

    expect(fallbackHandler).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
    expect(result.text).toBe(
      [
        "I could not complete that request because the model returned actions that were not executed.",
        "Unexecuted actions: BLOCK.",
        "No side effects were applied.",
      ].join("\n"),
    );
  });

  it("propagates caller cancellation into chat pre-handlers", async () => {
    let preHandlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      preHandlerStarted = resolve;
    });
    let signalFromPreHandler: AbortSignal | undefined;
    const handleMessage = vi.fn();
    const runtime = createRuntime({
      drainChatPreHandlers: vi.fn(async (context) => {
        signalFromPreHandler = context.abortSignal;
        preHandlerStarted?.();
        await new Promise<void>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            "abort",
            () => reject(context.abortSignal?.reason),
            { once: true },
          );
        });
        return null;
      }),
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "streaming-test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const caller = new AbortController();
    const generation = generateChatResponse(
      runtime,
      createChatMessage("cancel the pre-handler"),
      "Streaming Agent",
      { abortSignal: caller.signal },
    );
    await started;
    caller.abort(new DOMException("Client disconnected", "AbortError"));

    await expect(generation).rejects.toThrow("Client disconnected");
    expect(signalFromPreHandler?.aborted).toBe(true);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("finalizes a pre-handler result that wins the cancellation race", async () => {
    const caller = new AbortController();
    const handleMessage = vi.fn();
    const drainChatPreHandlers = vi.fn(async () => {
      caller.abort(new DOMException("socket closed", "AbortError"));
      return { responseText: "direct result completed" };
    });
    const runtime = createRuntime({
      drainChatPreHandlers,
      messageService: {
        handleMessage,
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "streaming-test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      },
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("run the direct handler"),
      "Streaming Agent",
      { abortSignal: caller.signal },
    );

    expect(drainChatPreHandlers).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(result.text).toBe("direct result completed");
  });

  it("finalizes a committed direct action across a late cancellation", async () => {
    const caller = new AbortController();
    const actionHandler = vi.fn(async () => {
      caller.abort(new DOMException("socket closed", "AbortError"));
      return {
        success: true,
        text: "Task committed.",
        data: { actionName: "START_CODING_TASK" },
      };
    });
    const action = {
      name: "START_CODING_TASK",
      description: "Create a coding task.",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: actionHandler,
    } satisfies Action;
    const runtime = createRuntime({
      actions: [action],
      getService: vi.fn((serviceType: string) =>
        serviceType === "SWARM_COORDINATOR" ? ({} as never) : null,
      ) as AgentRuntime["getService"],
    });
    const message = createChatMessage("build the durable fix");
    message.entityId = runtime.agentId;
    message.content = {
      ...message.content,
      metadata: { intent: "create_task" },
    };

    const result = await generateChatResponse(
      runtime,
      message,
      "Streaming Agent",
      { abortSignal: caller.signal },
    );

    expect(actionHandler).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Task committed.");
  });

  it("rejects ingress hook failures before starting message generation", async () => {
    const hookFailure = new Error("trajectory persistence failed");
    const handleMessage = vi.fn(async () => ({
      didRespond: true,
      responseContent: { text: "must not be generated" },
      responseMessages: [],
    }));
    const runtime = createRuntime({
      emitEvent: vi.fn(async () => {
        throw hookFailure;
      }),
      messageService: {
        handleMessage,
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
        createChatMessage("persist ingress first"),
        "Streaming Agent",
      ),
    ).rejects.toBe(hookFailure);
    expect(handleMessage).not.toHaveBeenCalled();
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
  it("returns a short unquoted title from the model", async () => {
    const useModel = createUseModelMock(async () => '"Local Voice Chat"');
    const runtime = createRuntime({ useModel });

    await expect(
      generateConversationTitle(
        runtime,
        "Can you answer from the local voice backend?",
        "Streaming Agent",
      ),
    ).resolves.toBe("Local Voice Chat");
    expect(useModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxTokens: 20,
        temperature: 0.7,
        prompt: expect.stringContaining(
          "Can you answer from the local voice backend?",
        ),
      }),
    );
  });

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
      { signal: controller.signal },
    );

    controller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).rejects.toThrow("client left");
    expect(signalFromParams?.aborted).toBe(true);
  });
});
