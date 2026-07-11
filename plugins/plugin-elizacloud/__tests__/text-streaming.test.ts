/**
 * Unit tests for token-by-token cloud streaming on the native
 * `/chat/completions` route (src/models/text.ts). Cover the OpenAI-compatible
 * SSE parser, streamed tool-call delta assembly, the end-to-end
 * `streamNativeChatCompletion` (text/usage/finishReason/toolCalls), the
 * non-SSE buffered fallback, error surfacing, and the requirement that the
 * shared concurrency permit is held for the WHOLE stream (not just headers).
 *
 * No live API — `requestRaw` is mocked to return constructed `Response`s.
 */
import type { IAgentRuntime, ResponseSkeleton } from "@elizaos/core";
import { logger, ResponseSkeletonStreamExtractor } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred = {
  resolve: (value: Response) => void;
  reject: (err: unknown) => void;
};

const transport = {
  inFlight: 0,
  maxInFlight: 0,
  pending: [] as Deferred[],
  reset() {
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.pending = [];
  },
};

// Default: requestRaw resolves immediately with whatever the test queued via
// `nextResponse`. When `nextResponse` is null it parks on a deferred so a test
// can control timing (used by the permit-lifetime test).
let nextResponse: Response | null = null;

const requestRaw = vi.fn(async (_method: string, _path: string, _opts?: unknown) => {
  transport.inFlight += 1;
  transport.maxInFlight = Math.max(transport.maxInFlight, transport.inFlight);
  try {
    if (nextResponse) {
      return nextResponse;
    }
    return await new Promise<Response>((resolve, reject) => {
      transport.pending.push({ resolve, reject });
    });
  } finally {
    transport.inFlight -= 1;
  }
});

vi.mock("../src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({ requestRaw }),
  createElizaCloudClient: () => ({}),
}));

import {
  __resetNativeChatLimiterForTests,
  accumulateToolCallDeltas,
  buildStreamAbortSignal,
  finalizeStreamedToolCalls,
  handleResponseHandler,
  handleTextSmall,
  parseOpenAiSseStream,
  resolveStreamingEnabled,
  resolveTextTimeoutMs,
  streamNativeChatCompletion,
} from "../src/models/text";

function fakeRuntime(): IAgentRuntime {
  return {
    character: { name: "Eliza", bio: [] },
    getSetting: () => undefined,
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

const enc = new TextEncoder();

/** Build a streamable Response from raw byte chunks (chunk boundaries matter). */
function sseResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/**
 * Like {@link sseResponse} but the underlying stream is left OPEN (never
 * `close()`d) and its `cancel` is observable. An early consumer break must call
 * `reader.cancel()` (parseOpenAiSseStream's finally), which on an open stream
 * invokes the source `cancel` — directly proving the upstream connection is torn
 * down (not just that the permit is freed).
 */
function openSseResponseWithCancelSpy(chunks: string[]): {
  response: Response;
  cancelSpy: ReturnType<typeof vi.fn>;
} {
  const cancelSpy = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Enqueue all frames but DO NOT close — so the stream is still readable
      // when the consumer breaks and reader.cancel() reaches the source.
      for (const c of chunks) controller.enqueue(enc.encode(c));
    },
    cancel(reason) {
      cancelSpy(reason);
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    cancelSpy,
  };
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentDelta(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

/**
 * One SSE frame carrying a `delta.tool_calls[0]` fragment (index 0). The Stage-1
 * RESPONSE_HANDLER reply forces this shape — Cerebras returns the envelope as
 * tool-call ARGUMENT deltas, never `delta.content`.
 */
function toolCallDelta(args: string, opts: { id?: string; name?: string } = {}): unknown {
  const fn: Record<string, unknown> = { arguments: args };
  if (opts.name) fn.name = opts.name;
  const call: Record<string, unknown> = { index: 0, function: fn };
  if (opts.id) call.id = opts.id;
  return { choices: [{ index: 0, delta: { tool_calls: [call] } }] };
}

async function readStream(result: { textStream: AsyncIterable<string> }): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of result.textStream) out.push(chunk);
  return out;
}

function nativeParams(): never {
  // `providerOptions` makes hasNativeTransportOptions() true (native route).
  return { prompt: "hi", providerOptions: { eliza: {} } } as never;
}

describe("parseOpenAiSseStream", () => {
  it("yields each data frame and stops at [DONE]", async () => {
    const body = sseResponse([
      dataFrame(contentDelta("a")),
      dataFrame(contentDelta("b")),
      "data: [DONE]\n\n",
      dataFrame(contentDelta("never")),
    ]).body as ReadableStream<Uint8Array>;

    const frames: unknown[] = [];
    for await (const f of parseOpenAiSseStream(body)) frames.push(f);
    expect(frames).toHaveLength(2);
  });

  it("reassembles a frame split across read() boundaries", async () => {
    const full = dataFrame(contentDelta("hello"));
    const mid = Math.floor(full.length / 2);
    const body = sseResponse([full.slice(0, mid), full.slice(mid)])
      .body as ReadableStream<Uint8Array>;

    const frames: Array<Record<string, unknown>> = [];
    for await (const f of parseOpenAiSseStream(body)) frames.push(f);
    expect(frames).toHaveLength(1);
    const choice = (frames[0].choices as Array<{ delta: { content: string } }>)[0];
    expect(choice.delta.content).toBe("hello");
  });

  it("ignores comment/blank lines and malformed JSON", async () => {
    const body = sseResponse([
      ": keep-alive\n\n",
      "data: not-json\n\n",
      dataFrame(contentDelta("ok")),
    ]).body as ReadableStream<Uint8Array>;
    const frames: unknown[] = [];
    for await (const f of parseOpenAiSseStream(body)) frames.push(f);
    expect(frames).toHaveLength(1);
  });
});

describe("streamed tool-call delta assembly", () => {
  it("accumulates name + arguments across deltas by index", () => {
    const acc = new Map();
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'ty":"SF"}' } }]);
    const calls = finalizeStreamedToolCalls(acc);
    expect(calls).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
        input: { city: "SF" },
      },
    ]);
  });

  it("drops a partial call that never received a name", () => {
    const acc = new Map();
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: "{}" } }]);
    expect(finalizeStreamedToolCalls(acc)).toEqual([]);
  });

  it("does NOT double when Cerebras re-sends the complete args in a final aggregated frame", () => {
    // Cerebras streams the args incrementally, then emits a FINAL frame that
    // re-carries id + name + the COMPLETE arguments object. Appending that
    // re-send would yield `{"replyText":"PONG"}{"replyText":"PONG"}` (doubled).
    const acc = new Map();
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "call_1", function: { name: "HANDLE_RESPONSE", arguments: "" } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"replyText":"PO' } }]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'NG"}' } }]);
    // Aggregated re-send of the whole object (re-carries id + name).
    accumulateToolCallDeltas(acc, [
      {
        index: 0,
        id: "call_1",
        function: { name: "HANDLE_RESPONSE", arguments: '{"replyText":"PONG"}' },
      },
    ]);
    expect(finalizeStreamedToolCalls(acc)).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "HANDLE_RESPONSE",
        input: { replyText: "PONG" },
      },
    ]);
  });

  it("takes the authoritative re-send even when it diverges from the incremental copy", () => {
    // The cloud character ("lowercase naturally") can make the model emit a
    // different casing in the aggregated re-send than in the streamed fragments.
    // The re-send is the authoritative full copy — keep a single, valid object.
    const acc = new Map();
    accumulateToolCallDeltas(acc, [
      {
        index: 0,
        id: "call_1",
        function: { name: "HANDLE_RESPONSE", arguments: '{"replyText":"PONG"}' },
      },
    ]);
    accumulateToolCallDeltas(acc, [
      {
        index: 0,
        id: "call_1",
        function: { name: "HANDLE_RESPONSE", arguments: '{"replyText":"pong"}' },
      },
    ]);
    expect(finalizeStreamedToolCalls(acc)).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "HANDLE_RESPONSE",
        input: { replyText: "pong" },
      },
    ]);
  });

  it("does NOT replace mid-stream when a nested inner object closes early", () => {
    // Regression guard for the resend detector: a fragment can transiently
    // contain a closed INNER object (`{"a":{"b":1}`) while the OUTER object is
    // still open. JSON.parse rejects that prefix (a brace counter would not),
    // so the fragments must keep appending — never replace mid-object.
    const acc = new Map();
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "call_1", function: { name: "set_filter", arguments: '{"a":{"b":1}' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: ',"c":2}' } }]);
    expect(finalizeStreamedToolCalls(acc)).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "set_filter",
        input: { a: { b: 1 }, c: 2 },
      },
    ]);
  });
});

describe("streamNativeChatCompletion", () => {
  beforeEach(() => {
    transport.reset();
    nextResponse = null;
    requestRaw.mockClear();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });

  it("streams content chunks in order and resolves text/usage/finishReason", async () => {
    nextResponse = sseResponse([
      dataFrame(contentDelta("Hello")),
      dataFrame(contentDelta(" world")),
      dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      dataFrame({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    expect(await readStream(result)).toEqual(["Hello", " world"]);
    expect(await result.text).toBe("Hello world");
    expect(await result.finishReason).toBe("stop");
    expect((await result.usage)?.totalTokens).toBe(5);
  });

  it("surfaces streamed tool calls on the result", async () => {
    nextResponse = sseResponse([
      dataFrame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "ping", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    await readStream(result);
    const toolCalls = await (result as { toolCalls: Promise<unknown[]> }).toolCalls;
    expect(toolCalls).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "ping", input: {} },
    ]);
  });

  it("falls back to a single buffered chunk when the gateway answers non-SSE", async () => {
    nextResponse = new Response(
      JSON.stringify({
        choices: [{ message: { content: "buffered reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    expect(await readStream(result)).toEqual(["buffered reply"]);
    expect(await result.text).toBe("buffered reply");
  });

  it("throws on a non-2xx response", async () => {
    nextResponse = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    await expect(
      streamNativeChatCompletion(fakeRuntime(), "RESPONSE_HANDLER" as never, nativeParams(), {
        modelName: "gpt-oss-120b",
        prompt: "hi",
      })
    ).rejects.toThrow("rate limited");
  });

  it("holds the concurrency permit until the stream is fully consumed", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const makeResponse = () => sseResponse([dataFrame(contentDelta("x")), "data: [DONE]\n\n"]);

    // First streaming call acquires the only permit.
    nextResponse = makeResponse();
    const first = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    expect(requestRaw).toHaveBeenCalledTimes(1);

    // Second call must NOT fire its request until the first stream drains —
    // the permit is held across the whole stream, not released at headers.
    nextResponse = makeResponse();
    const secondPromise = streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(requestRaw).toHaveBeenCalledTimes(1);

    // Drain the first stream -> permit released -> second proceeds.
    await readStream(first);
    const second = await secondPromise;
    expect(requestRaw).toHaveBeenCalledTimes(2);
    await readStream(second);
  });

  it("releases the permit on an early consumer break without draining the stream", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    // A multi-chunk stream the consumer will abandon after the first token.
    nextResponse = sseResponse([
      dataFrame(contentDelta("one")),
      dataFrame(contentDelta("two")),
      dataFrame(contentDelta("three")),
      "data: [DONE]\n\n",
    ]);
    const first = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    expect(requestRaw).toHaveBeenCalledTimes(1);

    // Second call queues behind the only permit.
    nextResponse = sseResponse([dataFrame(contentDelta("x")), "data: [DONE]\n\n"]);
    const secondPromise = streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(requestRaw).toHaveBeenCalledTimes(1);

    // Pull exactly ONE chunk then break early: the generator's return() must
    // release the permit (and cancel the upstream) WITHOUT draining the
    // remaining "two"/"three" chunks, so the queued second call proceeds.
    let pulled = 0;
    for await (const _chunk of first.textStream) {
      pulled += 1;
      break;
    }
    expect(pulled).toBe(1);

    const second = await secondPromise;
    expect(requestRaw).toHaveBeenCalledTimes(2);
    await readStream(second);
  });

  it("cancels the upstream reader on an early consumer break (tears down the connection)", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const { response, cancelSpy } = openSseResponseWithCancelSpy([
      dataFrame(contentDelta("one")),
      dataFrame(contentDelta("two")),
      dataFrame(contentDelta("three")),
    ]);
    nextResponse = response;

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    // Pull exactly one token then break — the generator's return() chain must
    // reach parseOpenAiSseStream's finally and call reader.cancel() on the
    // still-open upstream stream.
    let pulled = 0;
    for await (const _chunk of result.textStream) {
      pulled += 1;
      break;
    }
    expect(pulled).toBe(1);
    // Give the unwinding finally blocks a microtask to run reader.cancel().
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("ELIZAOS_CLOUD_STREAMING=0 disables streaming (kill-switch)", () => {
    process.env.ELIZAOS_CLOUD_STREAMING = "0";
    expect(resolveStreamingEnabled()).toBe(false);
    process.env.ELIZAOS_CLOUD_STREAMING = "true";
    expect(resolveStreamingEnabled()).toBe(true);
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    expect(resolveStreamingEnabled()).toBe(true);
  });
});

/**
 * The Stage-1 RESPONSE_HANDLER call sets `tool_choice:"required"`, so Cerebras
 * returns the whole reply envelope (incl. `replyText`) as tool-call ARGUMENT
 * deltas — never `delta.content`. Without surfacing those into the textStream the
 * runtime's structured extractor sees nothing and the reply lands all at once.
 * These tests pin that the reply args ARE streamed (only on the structured
 * `streamStructured` path), de-duped against Cerebras's aggregated re-send, and
 * that the runtime extractor reduces the streamed envelope to ONLY `replyText`
 * (no control-field leak).
 */
describe("streamNativeChatCompletion — forced HANDLE_RESPONSE reply envelope", () => {
  function structuredParams(): never {
    // streamStructured===true is what gates tool-call-argument streaming.
    return {
      prompt: "hi",
      providerOptions: { eliza: {} },
      streamStructured: true,
    } as never;
  }

  beforeEach(() => {
    transport.reset();
    nextResponse = null;
    requestRaw.mockClear();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });
  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });

  it("surfaces tool-call argument deltas incrementally as the envelope grows", async () => {
    nextResponse = sseResponse([
      dataFrame(toolCallDelta("", { id: "call_1", name: "HANDLE_RESPONSE" })),
      dataFrame(toolCallDelta('{"shouldRespond":"RESPOND","contexts":["general"],')),
      dataFrame(toolCallDelta('"replyText":"On it ')),
      dataFrame(toolCallDelta('now."}')),
      dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      structuredParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    const chunks = await readStream(result);
    // Streamed across MULTIPLE chunks (the bug = one final blob).
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(
      '{"shouldRespond":"RESPOND","contexts":["general"],"replyText":"On it now."}'
    );
    // The authoritative deduped tool call is still surfaced for downstream parse.
    const toolCalls = await (result as { toolCalls: Promise<unknown[]> }).toolCalls;
    expect(toolCalls).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "HANDLE_RESPONSE",
        input: { shouldRespond: "RESPOND", contexts: ["general"], replyText: "On it now." },
      },
    ]);
  });

  it("does NOT double when Cerebras re-sends the complete envelope in a final frame", async () => {
    const full = '{"shouldRespond":"RESPOND","replyText":"PONG"}';
    nextResponse = sseResponse([
      dataFrame(toolCallDelta("", { id: "call_1", name: "HANDLE_RESPONSE" })),
      dataFrame(toolCallDelta('{"shouldRespond":"RESPOND","replyText":"PO')),
      dataFrame(toolCallDelta('NG"}')),
      // Aggregated re-send re-carrying id + name + the COMPLETE object.
      dataFrame(toolCallDelta(full, { id: "call_1", name: "HANDLE_RESPONSE" })),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      structuredParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    // The envelope is streamed exactly once — the re-send adds nothing.
    expect((await readStream(result)).join("")).toBe(full);
  });

  it("stays buffered (no tool-arg streaming) when streamStructured is absent", async () => {
    nextResponse = sseResponse([
      dataFrame(toolCallDelta("", { id: "call_1", name: "HANDLE_RESPONSE" })),
      dataFrame(toolCallDelta('{"replyText":"hi"}')),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      nativeParams(), // no streamStructured
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    // Nothing reaches the UI token stream — the planner/non-structured shape must
    // not leak its raw tool-call args.
    expect(await readStream(result)).toEqual([]);
    const toolCalls = await (result as { toolCalls: Promise<unknown[]> }).toolCalls;
    expect(toolCalls).toHaveLength(1);
  });

  it("runtime extractor reduces the streamed envelope to ONLY replyText (no control-field leak)", async () => {
    nextResponse = sseResponse([
      dataFrame(toolCallDelta("", { id: "call_1", name: "HANDLE_RESPONSE" })),
      dataFrame(toolCallDelta('{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],')),
      dataFrame(toolCallDelta('"replyText":"On it ')),
      dataFrame(toolCallDelta('now.","facts":[]}')),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      structuredParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    // Feed the streamed chunks through the same extractor the runtime uses for the
    // RESPONSE_HANDLER reply (unordered, streamFields=["replyText"]).
    const visible: string[] = [];
    const skeleton: ResponseSkeleton = { spans: [], id: "test" };
    const extractor = new ResponseSkeletonStreamExtractor({
      skeleton,
      streamFields: ["replyText"],
      unordered: true,
      onChunk: (chunk) => visible.push(chunk),
    });
    for await (const chunk of result.textStream) extractor.push(chunk);
    extractor.flush();

    expect(visible.join("")).toBe("On it now.");
    // The control fields were carried in the streamed envelope but never surfaced.
    expect(visible.join("")).not.toContain("shouldRespond");
    expect(visible.join("")).not.toContain("contexts");
  });

  it("hides provider prose that arrives before the forced tool-call envelope", async () => {
    nextResponse = sseResponse([
      dataFrame(contentDelta("pre")),
      dataFrame(toolCallDelta("", { id: "call_1", name: "HANDLE_RESPONSE" })),
      dataFrame(toolCallDelta('{"replyText":"hel')),
      dataFrame(toolCallDelta('lo"}')),
      "data: [DONE]\n\n",
    ]);

    const result = await streamNativeChatCompletion(
      fakeRuntime(),
      "RESPONSE_HANDLER" as never,
      structuredParams(),
      { modelName: "gpt-oss-120b", prompt: "hi" }
    );

    const chunks = await readStream(result);
    expect(chunks.join("")).toBe('{"replyText":"hello"}');
    expect(chunks.join("")).not.toContain("pre");

    const visible: string[] = [];
    const extractor = new ResponseSkeletonStreamExtractor({
      skeleton: { spans: [], id: "test" },
      streamFields: ["replyText"],
      unordered: true,
      onChunk: (chunk) => visible.push(chunk),
    });
    for (const chunk of chunks) extractor.push(chunk);
    extractor.flush();

    expect(visible.join("")).toBe("hello");
  });
});

describe("resolveTextTimeoutMs", () => {
  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS;
  });

  it("defaults to 120000 when the env is unset or blank", () => {
    delete process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS;
    expect(resolveTextTimeoutMs()).toBe(120_000);
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "   ";
    expect(resolveTextTimeoutMs()).toBe(120_000);
  });

  it("uses a positive override value", () => {
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "5000";
    expect(resolveTextTimeoutMs()).toBe(5_000);
  });

  it("treats 0 / negative as opt-out (no client-side timeout)", () => {
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "0";
    expect(resolveTextTimeoutMs()).toBeUndefined();
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "-1";
    expect(resolveTextTimeoutMs()).toBeUndefined();
  });

  it("falls back to the default on a non-numeric value", () => {
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "abc";
    expect(resolveTextTimeoutMs()).toBe(120_000);
  });
});

/**
 * The routing DECISION in generateTextWithModel (text.ts wantsStream gate): only
 * the structured RESPONSE_HANDLER reply (`stream && streamStructured===true`)
 * streams token-by-token; everything else stays buffered so the planner/raw
 * envelope can't leak into the UI token stream. Distinguished by whether the
 * outgoing /chat/completions body carries `stream:true`.
 */
describe("cloud streaming gate decision (wantsStream)", () => {
  function bufferedChatResponse(text: string): Response {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function lastJson(): Record<string, unknown> {
    const call = requestRaw.mock.calls.at(-1) as [
      string,
      string,
      { json?: Record<string, unknown> },
    ];
    return call[2].json ?? {};
  }

  beforeEach(() => {
    transport.reset();
    nextResponse = null;
    requestRaw.mockClear();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });
  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    __resetNativeChatLimiterForTests();
  });

  it("streams when native + stream + streamStructured===true (streaming enabled)", async () => {
    nextResponse = sseResponse([dataFrame(contentDelta("hi")), "data: [DONE]\n\n"]);
    const result = (await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
      stream: true,
      streamStructured: true,
    } as never)) as { textStream: AsyncIterable<string> };
    await readStream(result);
    expect(requestRaw).toHaveBeenCalledWith("POST", "/chat/completions", expect.anything());
    expect(lastJson().stream).toBe(true);
  });

  it("stays buffered when streamStructured===false (no leak of the raw envelope)", async () => {
    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
      stream: true,
      streamStructured: false,
    } as never);
    expect(lastJson().stream).not.toBe(true);
  });

  it("stays buffered when streamStructured is absent (planner-shaped call)", async () => {
    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
      stream: true,
    } as never);
    expect(lastJson().stream).not.toBe(true);
  });

  it("stays buffered when the kill-switch is on even with streamStructured===true", async () => {
    process.env.ELIZAOS_CLOUD_STREAMING = "0";
    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
      stream: true,
      streamStructured: true,
    } as never);
    expect(lastJson().stream).not.toBe(true);
  });

  it("omits native max_tokens only when omitMaxTokens is set", async () => {
    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
      omitMaxTokens: true,
    } as never);
    expect(lastJson()).not.toHaveProperty("max_tokens");

    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      providerOptions: { eliza: {} },
    } as never);
    expect(lastJson().max_tokens).toBe(8192);
  });

  it("omits responses max_output_tokens only when omitMaxTokens is set", async () => {
    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
      omitMaxTokens: true,
    } as never);
    expect(lastJson()).not.toHaveProperty("max_output_tokens");

    nextResponse = bufferedChatResponse("buffered reply");
    await handleResponseHandler(fakeRuntime(), {
      prompt: "hi",
    } as never);
    expect(lastJson().max_output_tokens).toBe(8192);
  });

  it("never logs rendered prompt content while preserving the provider request", async () => {
    const promptMarker = "secret-prompt-marker-16083";
    const loggerSpies = [
      vi.spyOn(logger, "trace").mockImplementation(() => undefined),
      vi.spyOn(logger, "debug").mockImplementation(() => undefined),
      vi.spyOn(logger, "info").mockImplementation(() => undefined),
      vi.spyOn(logger, "warn").mockImplementation(() => undefined),
      vi.spyOn(logger, "error").mockImplementation(() => undefined),
      vi.spyOn(logger, "fatal").mockImplementation(() => undefined),
      vi.spyOn(logger, "success").mockImplementation(() => undefined),
      vi.spyOn(logger, "progress").mockImplementation(() => undefined),
      vi.spyOn(logger, "log").mockImplementation(() => undefined),
    ];

    try {
      nextResponse = bufferedChatResponse("safe response");
      await expect(
        handleTextSmall(fakeRuntime(), {
          prompt: "fallback prompt",
          messages: [{ role: "user", content: promptMarker }],
        } as never)
      ).resolves.toMatchObject({ text: "safe response" });

      expect(JSON.stringify(lastJson())).toContain(promptMarker);
      expect(JSON.stringify(loggerSpies.flatMap((spy) => spy.mock.calls))).not.toContain(
        promptMarker
      );
      expect(loggerSpies.at(-1)).toHaveBeenCalledWith(
        expect.stringContaining("Using TEXT_SMALL model")
      );
    } finally {
      for (const spy of loggerSpies) spy.mockRestore();
    }
  });
});

describe("buildStreamAbortSignal", () => {
  it("returns undefined when neither a runtime signal nor a positive timeout is given", () => {
    expect(buildStreamAbortSignal(undefined, undefined)).toBeUndefined();
    expect(buildStreamAbortSignal(undefined, 0)).toBeUndefined();
    expect(buildStreamAbortSignal(undefined, -5)).toBeUndefined();
  });

  it("returns the runtime signal alone when no positive timeout", () => {
    const ac = new AbortController();
    expect(buildStreamAbortSignal(ac.signal, 0)).toBe(ac.signal);
    expect(buildStreamAbortSignal(ac.signal, undefined)).toBe(ac.signal);
  });

  it("returns a timeout-only signal when no runtime signal", () => {
    const sig = buildStreamAbortSignal(undefined, 10_000);
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig).not.toBeNull();
  });

  it("merges both so aborting the runtime signal aborts the result", () => {
    const ac = new AbortController();
    const merged = buildStreamAbortSignal(ac.signal, 10_000);
    expect(merged).toBeInstanceOf(AbortSignal);
    expect(merged?.aborted).toBe(false);
    ac.abort();
    expect(merged?.aborted).toBe(true);
  });
});
