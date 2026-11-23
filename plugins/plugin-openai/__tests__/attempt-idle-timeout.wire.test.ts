/**
 * A streamed HTTP attempt of a text call is bounded by its idle limit: the wait
 * for its response headers and each gap between its body chunks. A request or
 * re-send the provider never answers fails the call within that limit instead
 * of holding the turn until the caller's chat deadline, and is not re-sent. A
 * non-streamed attempt gets its headers only when generation ends, so the limit
 * never cuts it; the caller's signal bounds it. The limit is a fixed 60 s on
 * the direct Cerebras route and there is no setting for it; cases that reach
 * it run on a fake clock. Drives the real text handlers and AI SDK against a
 * local provider.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleActionPlanner, handleResponseHandler } from "../models/text";
import { createOpenAIClient } from "../providers";

/**
 * The fetch each client hands the AI SDK, kept so one test can read a response
 * through it directly. The SDK reads a stream ahead of the handler's consumer,
 * so only a direct reader can pause between the wrapper's own reads.
 */
const clientFetch = vi.hoisted(() => ({ latest: undefined as typeof fetch | undefined }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
  return {
    ...actual,
    createOpenAI: (options: Parameters<typeof actual.createOpenAI>[0]) => {
      clientFetch.latest = options?.fetch;
      return actual.createOpenAI(options);
    },
  };
});

type Answer = "answer" | "silent" | "slow" | "headers-only" | "chunked";

interface Script {
  /** The first attempt fails with a 503, which the lanes re-send promptly. */
  firstFails?: boolean;
  answer: Answer;
  /** "slow": wait before the whole answer. "chunked": gap between pieces. */
  delayMs?: number;
  /** "chunked": how many pieces the answer arrives in. */
  pieces?: number;
}

/** The direct Cerebras route's fixed idle limit. */
const IDLE_MS = 60_000;

let server: Server | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

const chunk = {
  id: "chatcmpl-idle",
  object: "chat.completion.chunk",
  created: 1,
  model: "qwen-3.8-27b",
};
const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const contentFrame = (content: string) =>
  frame({ ...chunk, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const closingFrames = `${frame({
  ...chunk,
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
})}data: [DONE]\n\n`;
const completion = (content: string) =>
  JSON.stringify({
    id: "chatcmpl-idle",
    object: "chat.completion",
    created: 1,
    model: "qwen-3.8-27b",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });

/** Writes `parts` one every `gapMs`, then ends the response. */
function writeSpaced(response: ServerResponse, parts: string[], gapMs: number) {
  const next = (index: number) => {
    if (index === parts.length) {
      response.end();
      return;
    }
    response.write(parts[index]);
    setTimeout(() => next(index + 1), gapMs);
  };
  next(0);
}

async function provider(script: Script) {
  let requests = 0;
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      requests++;
      const stream = JSON.parse(text || "{}").stream === true;
      if (script.firstFails && requests === 1) {
        // The provider's own transient failure: the lanes re-send this once promptly.
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: "Encountered a server error, please try again",
            type: "server_error",
          })
        );
        return;
      }
      const contentType = stream ? "text/event-stream" : "application/json";
      const answer = () => {
        response.writeHead(200, { "content-type": contentType });
        response.end(stream ? contentFrame("Recovered") + closingFrames : completion("Recovered"));
      };
      if (script.answer === "answer") answer();
      else if (script.answer === "slow") setTimeout(answer, script.delayMs ?? 0);
      else if (script.answer === "headers-only") {
        response.writeHead(200, { "content-type": contentType });
        response.flushHeaders();
      } else if (script.answer === "chunked") {
        const pieces = script.pieces ?? 6;
        response.writeHead(200, { "content-type": contentType });
        if (stream) {
          const parts = Array.from({ length: pieces }, (_, index) =>
            contentFrame(String(index + 1))
          );
          parts.push(closingFrames);
          writeSpaced(response, parts, script.delayMs ?? 0);
        } else {
          const body = completion("Recovered");
          const size = Math.ceil(body.length / pieces);
          const parts = Array.from({ length: pieces }, (_, index) =>
            body.slice(index * size, (index + 1) * size)
          );
          writeSpaced(response, parts, script.delayMs ?? 0);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  vi.stubEnv("OPENAI_API_KEY", "local-test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("CEREBRAS_API_KEY", "");
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  for (const slot of [
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
    "OPENAI_ACTION_PLANNER_MODEL",
    "OPENAI_RESPONSE_HANDLER_MODEL",
  ])
    vi.stubEnv(slot, "qwen-3.8-27b");
  const runtime = new AgentRuntime({
    character: {
      name: "AttemptIdleTest",
      settings: { OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: baseURL },
    },
  });
  return { runtime, baseURL, requests: () => requests };
}

/**
 * One text call through the planner's live stream (a streamed request) or
 * Stage 1's generate lane (a non-streamed request). `pauseMs` makes the stream
 * consumer wait that long after every part it reads.
 */
async function call(
  runtime: AgentRuntime,
  lane: "stream" | "generate",
  signal: AbortSignal,
  pauseMs = 0
) {
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  try {
    if (lane === "stream") {
      const result = await handleActionPlanner(runtime, {
        prompt: "Reply briefly.",
        stream: true,
        signal,
      } as never);
      let text = typeof result === "string" ? result : "";
      if (typeof result !== "string")
        for await (const part of (result as { textStream: AsyncIterable<string> }).textStream) {
          text += part;
          if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
      return { text, elapsedMs: elapsed() };
    }
    const result = await handleResponseHandler(runtime, {
      prompt: "Reply briefly.",
      signal,
    } as never);
    return { text: String(result), elapsedMs: elapsed() };
  } catch (error) {
    return { error, elapsedMs: elapsed() };
  }
}

const idleCode = (error: unknown): unknown => {
  const seen = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return seen?.code ?? seen?.cause?.code;
};

/**
 * Advances a fake clock (setTimeout only) in steps until `work` settles or
 * `limitMs` of fake time has passed, yielding to real I/O after every step.
 * Returns the fake time at which it settled, or undefined when it had not.
 */
async function runOnFakeClock(work: Promise<unknown>, limitMs: number) {
  let settled = false;
  void work.finally(() => {
    settled = true;
  });
  let fakeMs = 0;
  while (!settled && fakeMs < limitMs) {
    await vi.advanceTimersByTimeAsync(250);
    fakeMs += 250;
    for (let turn = 0; turn < 3 && !settled; turn++)
      await new Promise((resolve) => setImmediate(resolve));
  }
  return settled ? fakeMs : undefined;
}

/** Fake setTimeout only: the provider's delays and the idle limit share it. */
const useFakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

describe("idle-bounded streamed attempts (planner live stream)", () => {
  it("re-sends a failed attempt and returns the answered re-send", async () => {
    const test = await provider({ firstFails: true, answer: "answer" });
    const result = await call(test.runtime, "stream", AbortSignal.timeout(10_000));
    expect(result.text).toBe("Recovered");
    expect(test.requests()).toBe(2);
  }, 20_000);

  it("fails at the idle limit when headers never come, and does not re-send", async () => {
    const test = await provider({ answer: "silent" });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
    const result = await work;
    expect(idleCode(result.error)).toBe("MODEL_ATTEMPT_IDLE_TIMEOUT");
    expect(settledAtMs).toBeGreaterThanOrEqual(IDLE_MS);
    expect(settledAtMs).toBeLessThanOrEqual(IDLE_MS + 1_000);
    expect(test.requests()).toBe(1);
  }, 60_000);

  it("fails the call at the idle limit when the re-send is never answered", async () => {
    const test = await provider({ firstFails: true, answer: "silent" });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
    const result = await work;
    expect(idleCode(result.error)).toBe("MODEL_ATTEMPT_IDLE_TIMEOUT");
    // One prompt re-send plus one idle limit.
    expect(settledAtMs).toBeGreaterThanOrEqual(IDLE_MS);
    expect(settledAtMs).toBeLessThan(IDLE_MS + 5_000);
    expect(test.requests()).toBe(2);
  }, 60_000);

  it("waits for a slow first byte that comes inside the idle limit", async () => {
    const test = await provider({ firstFails: true, answer: "slow", delayMs: IDLE_MS - 5_000 });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    expect(await runOnFakeClock(work, IDLE_MS + 30_000)).toBeDefined();
    const result = await work;
    expect(result.text).toBe("Recovered");
    expect(test.requests()).toBe(2);
  }, 60_000);

  it("fails the call when a slow first byte outlasts the idle limit", async () => {
    const test = await provider({ firstFails: true, answer: "slow", delayMs: IDLE_MS + 20_000 });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
    const result = await work;
    expect(idleCode(result.error)).toBe("MODEL_ATTEMPT_IDLE_TIMEOUT");
    expect(settledAtMs).toBeLessThan(IDLE_MS + 5_000);
    expect(test.requests()).toBe(2);
  }, 60_000);

  it("fails the call when a re-send sends headers and then no body", async () => {
    const test = await provider({ firstFails: true, answer: "headers-only" });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
    const result = await work;
    expect(idleCode(result.error)).toBe("MODEL_ATTEMPT_IDLE_TIMEOUT");
    expect(settledAtMs).toBeLessThan(IDLE_MS + 5_000);
    expect(test.requests()).toBe(2);
  }, 60_000);

  it("keeps a body whose chunks arrive every 30 s for 3 minutes", async () => {
    const test = await provider({ answer: "chunked", pieces: 6, delayMs: IDLE_MS / 2 });
    useFakeClock();
    const work = call(test.runtime, "stream", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, 6 * IDLE_MS);
    const result = await work;
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("123456");
    expect(settledAtMs).toBeGreaterThanOrEqual(5 * (IDLE_MS / 2));
    expect(test.requests()).toBe(1);
  }, 60_000);

  it("does not count the consumer's pauses between reads", async () => {
    const test = await provider({ answer: "chunked", pieces: 4, delayMs: IDLE_MS / 5 });
    useFakeClock();
    // Each pause is longer than the limit, while the provider's gaps are a fifth of it.
    const pauseMs = IDLE_MS + 30_000;
    const work = call(test.runtime, "stream", new AbortController().signal, pauseMs);
    const settledAtMs = await runOnFakeClock(work, 6 * pauseMs);
    const result = await work;
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("1234");
    expect(settledAtMs).toBeGreaterThanOrEqual(4 * pauseMs);
    expect(test.requests()).toBe(1);
  }, 60_000);

  it("does not count a direct reader's pauses between the wrapper's reads", async () => {
    const test = await provider({ answer: "chunked", pieces: 4, delayMs: IDLE_MS / 5 });
    createOpenAIClient(test.runtime);
    const send = clientFetch.latest;
    if (!send) throw new Error("the client did not hand the AI SDK a fetch");
    useFakeClock();
    const pauseMs = IDLE_MS + 30_000;
    const read = (async () => {
      const response = await send(`${test.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen-3.8-27b", stream: true, messages: [] }),
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
        // Longer than the limit, while the provider's gaps are a fifth of it.
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      return text;
    })();
    const settledAtMs = await runOnFakeClock(read, 8 * pauseMs);
    const text = await read;
    expect(settledAtMs).toBeGreaterThanOrEqual(pauseMs);
    for (const piece of ["1", "2", "3", "4"]) expect(text).toContain(`"content":"${piece}"`);
    expect(text).toContain("data: [DONE]");
    expect(test.requests()).toBe(1);
  }, 60_000);

  it("ends a silent re-send with the caller's own abort before the idle limit", async () => {
    const test = await provider({ firstFails: true, answer: "silent" });
    const reason = new Error("caller deadline");
    const owner = new AbortController();
    setTimeout(() => owner.abort(reason), 1_500);
    const result = await call(test.runtime, "stream", owner.signal);
    expect(result.error).toBe(reason);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(test.requests()).toBe(2);
  }, 20_000);
});

describe("non-streamed attempts are not idle-bounded (Stage 1 generate)", () => {
  it("re-sends a failed attempt and returns the answered re-send", async () => {
    const test = await provider({ firstFails: true, answer: "answer" });
    const result = await call(test.runtime, "generate", AbortSignal.timeout(10_000));
    expect(result.text).toBe("Recovered");
    expect(test.requests()).toBe(2);
  }, 20_000);

  it("lets a non-streamed answer take longer than the idle limit", async () => {
    const test = await provider({ answer: "slow", delayMs: IDLE_MS + 1_000 });
    useFakeClock();
    const work = call(test.runtime, "generate", new AbortController().signal);
    const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
    const result = await work;
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Recovered");
    expect(settledAtMs).toBeGreaterThanOrEqual(IDLE_MS + 1_000);
    expect(test.requests()).toBe(1);
  }, 60_000);

  it("keeps a body whose pieces arrive every 0.5 s for 3 s", async () => {
    const test = await provider({ answer: "chunked", pieces: 6, delayMs: 500 });
    const result = await call(test.runtime, "generate", AbortSignal.timeout(10_000));
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Recovered");
    expect(test.requests()).toBe(1);
  }, 20_000);

  it("leaves a silent attempt to the caller's own abort", async () => {
    const test = await provider({ answer: "silent" });
    const reason = new Error("caller deadline");
    const owner = new AbortController();
    setTimeout(() => owner.abort(reason), 2_500);
    const result = await call(test.runtime, "generate", owner.signal);
    expect(result.error).toBe(reason);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2_400);
    expect(test.requests()).toBe(1);
  }, 20_000);
});

describe("the fixed limit", () => {
  it.each(["0", "1", "600"])(
    "ignores the former OPENAI_ATTEMPT_IDLE_TIMEOUT_SECONDS=%s",
    async (value) => {
      const test = await provider({ answer: "silent" });
      vi.stubEnv("OPENAI_ATTEMPT_IDLE_TIMEOUT_SECONDS", value);
      useFakeClock();
      const work = call(test.runtime, "stream", new AbortController().signal);
      const settledAtMs = await runOnFakeClock(work, IDLE_MS + 30_000);
      const result = await work;
      expect(idleCode(result.error)).toBe("MODEL_ATTEMPT_IDLE_TIMEOUT");
      expect(settledAtMs).toBeGreaterThanOrEqual(IDLE_MS);
      expect(settledAtMs).toBeLessThanOrEqual(IDLE_MS + 1_000);
      expect(test.requests()).toBe(1);
    },
    60_000
  );

  it("leaves a streamed attempt off the direct Cerebras route unbounded", async () => {
    const test = await provider({ answer: "silent" });
    vi.stubEnv("ELIZA_PROVIDER", "openai");
    useFakeClock();
    const reason = new Error("caller deadline");
    const owner = new AbortController();
    const work = call(test.runtime, "stream", owner.signal);
    expect(await runOnFakeClock(work, 2 * IDLE_MS)).toBeUndefined();
    owner.abort(reason);
    const result = await work;
    expect(result.error).toBe(reason);
    expect(test.requests()).toBe(1);
  }, 60_000);
});
