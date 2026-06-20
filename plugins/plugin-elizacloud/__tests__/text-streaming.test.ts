/**
 * Unit tests for the streaming plain-prompt cloud text path in
 * `src/models/text.ts`.
 *
 * Asserts:
 *   - a plain `{ prompt, stream: true }` call yields incremental SSE chunks
 *     (a real TextStreamResult), not a buffered string;
 *   - native-transport calls (tools / responseSchema) still use the buffered
 *     `/chat/completions` round-trip, never the SSE stream;
 *   - a streaming setup error (bad status) falls back to the buffered
 *     `/responses` path without dropping the turn;
 *   - the shared native-concurrency permit is HELD across the full stream
 *     lifetime and RELEASED when the stream ends, so a streaming call cannot
 *     reintroduce the 429 burst.
 *
 * Everything is driven by a fake `requestRaw` backed by controllable streams —
 * NO live API.
 */
import type { IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured requests so we can assert which route/stream-flag each call used.
type CapturedRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

const captured: CapturedRequest[] = [];

// Queue of responses the fake transport returns, in call order. Each entry is a
// factory so a test can build a fresh Response (streams are single-use) per call.
let responseQueue: Array<() => Promise<Response> | Response> = [];

const requestRaw = vi.fn(
  async (
    method: string,
    path: string,
    opts?: { json?: unknown; headers?: Record<string, string> }
  ) => {
    captured.push({
      method,
      path,
      body: (opts?.json as Record<string, unknown>) ?? {},
      headers: opts?.headers ?? {},
    });
    const factory = responseQueue.shift();
    if (!factory) {
      throw new Error(`unexpected requestRaw call: ${method} ${path}`);
    }
    return factory();
  }
);

vi.mock("../src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({ requestRaw }),
  createElizaCloudClient: () => ({}),
}));

import {
  __resetNativeChatLimiterForTests,
  generateNativeChatCompletion,
  handleTextLarge,
  withNativeChatLimit,
} from "../src/models/text";

function fakeRuntime(): IAgentRuntime {
  return {
    character: { name: "Eliza", bio: [] },
    getSetting: () => undefined,
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

/** Build an SSE chat.completion.chunk `data:` line for one content delta. */
function deltaEvent(content: string, finishReason?: string | null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

function usageEvent(): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  })}\n\n`;
}

/**
 * A streaming Response whose body emits each SSE frame only once the previous
 * frame has been pulled — and only after the test invokes `release(n)`. This
 * lets us observe that the permit stays held while the stream is mid-flight.
 */
function controllableSseResponse(frames: string[]): {
  response: Response;
  emit: (n?: number) => void;
} {
  const encoder = new TextEncoder();
  let idx = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const emit = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      if (idx < frames.length) {
        controller?.enqueue(encoder.encode(frames[idx]));
        idx += 1;
      } else {
        controller?.close();
        return;
      }
    }
    if (idx >= frames.length) {
      controller?.close();
    }
  };
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return { response, emit };
}

/**
 * A streaming Response that emits the given raw byte-chunks verbatim and in
 * order — deliberately NOT frame-aligned — so a single SSE event can be split
 * mid-line across two `reader.read()`s, the way real TCP segmentation splits a
 * socket. Exercises the pump's cross-read buffering.
 */
function rawChunkResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(encoder.encode(chunk));
      }
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A plain (non-stream) JSON Response, for buffered-path assertions. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Responses-API shaped buffered body (the /responses fallback path). */
function responsesBody(text: string): unknown {
  return {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function isStreamResult(value: unknown): value is TextStreamResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "textStream" in value &&
    "text" in value &&
    "usage" in value &&
    "finishReason" in value
  );
}

describe("elizacloud streaming plain-prompt text", () => {
  beforeEach(() => {
    captured.length = 0;
    responseQueue = [];
    requestRaw.mockClear();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    __resetNativeChatLimiterForTests();
  });

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    __resetNativeChatLimiterForTests();
  });

  it("yields incremental chunks for a streaming plain prompt", async () => {
    const frames = [deltaEvent("Hello"), deltaEvent(" world"), usageEvent(), "data: [DONE]\n\n"];
    const { response, emit } = controllableSseResponse(frames);
    responseQueue = [() => response];

    const result = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    expect(isStreamResult(result)).toBe(true);

    // It went out as a streaming /chat/completions request.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.path).toBe("/chat/completions");
    expect(captured[0]?.body.stream).toBe(true);

    // Consume the stream, emitting one frame per pulled chunk.
    const chunks: string[] = [];
    emit(1); // first delta
    const iterator = result.textStream[Symbol.asyncIterator]();
    const first = await iterator.next();
    chunks.push(first.value);
    emit(1); // second delta
    await flush();
    const second = await iterator.next();
    chunks.push(second.value);
    emit(2); // usage + [DONE] -> close

    // Drain to completion.
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
    }

    expect(chunks).toEqual(["Hello", " world"]);
    expect(await result.text).toBe("Hello world");
    expect(await result.finishReason).toBe("stop");
    const usage = await result.usage;
    expect(usage?.promptTokens).toBe(3);
    expect(usage?.completionTokens).toBe(4);
    expect(usage?.totalTokens).toBe(7);
  });

  it("reassembles an SSE frame split mid-line across two reads (TCP segmentation)", async () => {
    // One delta frame carrying "Hello world", sliced mid-JSON so the event
    // straddles two reader.read()s the way real socket segmentation splits it,
    // then the [DONE] sentinel tacked onto the tail chunk.
    const frame = deltaEvent("Hello world");
    const splitAt = Math.floor(frame.length / 2);
    // Sanity: the slice point is genuinely mid-line (no newline in the head).
    expect(frame.slice(0, splitAt)).not.toContain("\n");
    const chunks = [frame.slice(0, splitAt), `${frame.slice(splitAt)}data: [DONE]\n\n`];
    responseQueue = [() => rawChunkResponse(chunks)];

    const result = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    expect(isStreamResult(result)).toBe(true);

    const collected: string[] = [];
    for await (const chunk of result.textStream) {
      collected.push(chunk);
    }

    // The split frame parsed EXACTLY ONCE into the whole token — not garbled,
    // dropped, or double-counted across the read boundary.
    expect(collected).toEqual(["Hello world"]);
    expect(await result.text).toBe("Hello world");
  });

  it("uses the buffered /chat/completions path for native-transport calls even when stream is requested", async () => {
    responseQueue = [
      () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "c1", function: { name: "DO_IT", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    ];

    const result = await handleTextLarge(fakeRuntime(), {
      prompt: "plan",
      stream: true,
      tools: { DO_IT: { description: "do it", parameters: { type: "object" } } },
    } as never);

    // Native-transport result is the buffered object, NOT a stream.
    expect(isStreamResult(result)).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.path).toBe("/chat/completions");
    // The buffered native body never sets stream:true.
    expect(captured[0]?.body.stream).toBeUndefined();
    expect(captured[0]?.body.tools).toBeDefined();
  });

  it("falls back to the buffered /responses path when streaming setup fails", async () => {
    responseQueue = [
      // Stream attempt returns an error status -> streaming throws before the result.
      () => jsonResponse({ error: { message: "stream unavailable" } }, 503),
      // Buffered /responses fallback returns real text.
      () => jsonResponse(responsesBody("buffered reply")),
    ];

    const result = await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never);

    expect(typeof result).toBe("string");
    expect(result).toBe("buffered reply");

    // First the failed stream attempt, then the buffered /responses fallback.
    expect(captured.map((c) => c.path)).toEqual(["/chat/completions", "/responses"]);
    expect(captured[0]?.body.stream).toBe(true);
    expect(captured[1]?.body.stream).toBeUndefined();
  });

  it("holds the shared native permit for the full stream and releases it on completion", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const frames = [deltaEvent("a"), deltaEvent("b"), usageEvent(), "data: [DONE]\n\n"];
    const { response, emit } = controllableSseResponse(frames);
    responseQueue = [() => response];

    const result = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    // While the stream is mid-flight (not drained), a second native call that
    // shares the SAME cap must be BLOCKED on the limiter (never reaches the
    // transport). We probe with withNativeChatLimit directly.
    let secondEntered = false;
    const secondCall = withNativeChatLimit(async () => {
      secondEntered = true;
      return "ok";
    });
    await flush();
    // The streaming call still holds the only permit (cap=1), so the second is queued.
    expect(secondEntered).toBe(false);

    // Drive the stream to completion.
    emit(frames.length);
    const collected: string[] = [];
    for await (const chunk of result.textStream) {
      collected.push(chunk);
    }
    await result.text;
    await flush();

    // The permit was released at stream end -> the queued call now ran.
    expect(secondEntered).toBe(true);
    await secondCall;
    expect(collected).toEqual(["a", "b"]);
  });

  it("releases the native permit when the stream errors (next caller proceeds)", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    // A stream body that closes with no usable text -> the stream errors mid-flight.
    const { response, emit } = controllableSseResponse(["data: [DONE]\n\n"]);
    responseQueue = [() => response];

    const result = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    let secondEntered = false;
    const secondCall = withNativeChatLimit(async () => {
      secondEntered = true;
      return "ok";
    });
    await flush();
    expect(secondEntered).toBe(false);

    // Close the body with no content -> stream errors.
    emit(1);
    await expect(
      (async () => {
        for await (const _chunk of result.textStream) {
          // drain
        }
      })()
    ).rejects.toThrow();
    await flush();

    // Permit freed despite the error -> the queued caller ran.
    expect(secondEntered).toBe(true);
    await secondCall;
  });

  it("releases the native permit when the consumer breaks early (abort)", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const frames = [deltaEvent("a"), deltaEvent("b"), usageEvent(), "data: [DONE]\n\n"];
    const { response, emit } = controllableSseResponse(frames);
    responseQueue = [() => response];

    const result = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    // A second native call sharing the cap=1 limiter is queued while the stream
    // holds the only permit.
    let secondEntered = false;
    const secondCall = withNativeChatLimit(async () => {
      secondEntered = true;
      return "ok";
    });
    await flush();
    expect(secondEntered).toBe(false);

    // Pull one chunk, then ABANDON the stream mid-flight — a `for await … break`
    // / runtime abort invokes the iterator's return(). We never drain to the
    // natural end.
    emit(1);
    const iterator = result.textStream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe("a");
    await iterator.return?.();
    await flush();

    // The early break released the permit (didn't pin it until natural end) ->
    // the queued caller ran.
    expect(secondEntered).toBe(true);
    await secondCall;
  });

  it("does not stream when stream is not requested (buffered /responses)", async () => {
    responseQueue = [() => jsonResponse(responsesBody("plain buffered"))];

    const result = await handleTextLarge(fakeRuntime(), { prompt: "hi" } as never);

    expect(typeof result).toBe("string");
    expect(result).toBe("plain buffered");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.path).toBe("/responses");
  });

  it("shares one cap across a streaming call and a buffered native call", async () => {
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();

    const frames = [deltaEvent("x"), usageEvent(), "data: [DONE]\n\n"];
    const { response, emit } = controllableSseResponse(frames);
    responseQueue = [() => response];

    const streamResult = (await handleTextLarge(fakeRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as TextStreamResult;

    // Fire a buffered native call (shares the cap). It must NOT reach the
    // transport while the stream holds the only permit.
    const bufferedPromise = generateNativeChatCompletion(
      fakeRuntime(),
      "TEXT_LARGE" as never,
      { prompt: "hi" } as never,
      { modelName: "cerebras/gpt-oss-120b", prompt: "hi" }
    );
    await flush();
    // Only the streaming request has hit the transport so far.
    expect(requestRaw).toHaveBeenCalledTimes(1);

    // The buffered native call's response is queued for when the permit frees.
    responseQueue.push(() =>
      jsonResponse({
        choices: [{ message: { content: "buffered after stream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );

    emit(frames.length);
    for await (const _chunk of streamResult.textStream) {
      // drain the stream -> releases the permit at end
    }
    await streamResult.text;

    const buffered = await bufferedPromise;
    expect(buffered.text).toBe("buffered after stream");
    // Both calls eventually hit the transport, but never simultaneously.
    expect(requestRaw).toHaveBeenCalledTimes(2);
  });
});
