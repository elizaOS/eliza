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
import type { IAgentRuntime } from "@elizaos/core";
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
  finalizeStreamedToolCalls,
  parseOpenAiSseStream,
  resolveStreamingEnabled,
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

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentDelta(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] };
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

  it("ELIZAOS_CLOUD_STREAMING=0 disables streaming (kill-switch)", () => {
    process.env.ELIZAOS_CLOUD_STREAMING = "0";
    expect(resolveStreamingEnabled()).toBe(false);
    process.env.ELIZAOS_CLOUD_STREAMING = "true";
    expect(resolveStreamingEnabled()).toBe(true);
    delete process.env.ELIZAOS_CLOUD_STREAMING;
    expect(resolveStreamingEnabled()).toBe(true);
  });
});
