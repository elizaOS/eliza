/**
 * Shape tests for the transient-retry lanes: a transient provider error that
 * kills the stream BEFORE its first token (Cerebras's "Encountered a server
 * error, please try again" arrives via `onError` with an empty stream, or as
 * a throw on the first pull) retries with backoff, because nothing has
 * reached the user yet. Mid-stream and non-transient failures stay fatal, a
 * cancelled request never retries (the backoff itself is abort-aware),
 * concurrent streams retry independently without amplification, and every
 * retried call surfaces retryCount/lastRetryReason on MODEL_USED and the
 * result's providerMetadata. Mocked `ai` SDK (fresh stream objects per call —
 * generators are single-use), no network; the live Cerebras failure this
 * fences rode the incident log.
 */
import { EventType, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: { object: () => ({}) },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    responses: (modelName: string) => ({ modelName }),
  }),
}));

function createRuntime() {
  return {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => undefined),
  } as never;
}

function plannerResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      thought: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            args: { type: "object" },
          },
          required: ["name"],
        },
      },
    },
    required: ["thought", "toolCalls"],
  };
}

const TRANSIENT = {
  message: "Encountered a server error, please try again",
  type: "server_error",
};

function successResult(tokens: string[]) {
  return {
    textStream: (async function* textStream() {
      for (const token of tokens) yield token;
    })(),
    fullStream: (async function* fullStream() {})(),
    text: Promise.resolve(tokens.join("")),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 5, outputTokens: 5 }),
  };
}

/** An attempt whose provider error surfaces via onError with an empty stream. */
function emptyErroredResult(onError: (arg: { error: unknown }) => void, error: unknown) {
  return {
    // biome-ignore lint/correctness/useYield: error-only stream fixture — the provider error surfaces via onError, no tokens.
    textStream: (async function* textStream() {
      onError({ error });
    })(),
    fullStream: (async function* fullStream() {})(),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("error"),
    usage: Promise.resolve(undefined),
  };
}

async function collect(stream: { textStream: AsyncIterable<string> }) {
  const chunks: string[] = [];
  for await (const chunk of stream.textStream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("live-stream start retry", () => {
  beforeEach(() => {
    // The plugin intentionally falls back to process.env when the runtime has
    // no setting. Pin the provider so a developer's live Cerebras key cannot
    // silently change which structured-output contract this unit test covers.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("CEREBRAS_API_KEY", undefined);
    vi.stubEnv("ELIZA_PROVIDER", undefined);
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries a transient onError-with-empty-stream failure and delivers the second attempt", async () => {
    let call = 0;
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) => {
      call++;
      return Promise.resolve(
        call === 1 ? emptyErroredResult(args.onError, TRANSIENT) : successResult(["hel", "lo"])
      );
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).resolves.toEqual(["hel", "lo"]);
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("survives a sustained transient burst: five stream-start failures, sixth attempt delivers", async () => {
    // Live 2026-08-02: Cerebras 500 bursts outlasted the previous 3-attempt
    // window and killed recoverable turns. The budget is now 5 retries; a
    // burst that clears within it must deliver, not fail the turn.
    let call = 0;
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) => {
      call++;
      return Promise.resolve(
        call <= 5 ? emptyErroredResult(args.onError, TRANSIENT) : successResult(["ok"])
      );
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).resolves.toEqual(["ok"]);
    expect(aiMocks.streamText).toHaveBeenCalledTimes(6);
  }, 30_000);

  it("retries a transient throw on the first pull", async () => {
    let call = 0;
    aiMocks.streamText.mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          // biome-ignore lint/correctness/useYield: throw-only stream fixture — fails on the first pull.
          textStream: (async function* textStream() {
            throw TRANSIENT;
          })(),
          fullStream: (async function* fullStream() {})(),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
          finishReason: Promise.resolve("error"),
          usage: Promise.resolve(undefined),
        });
      }
      return Promise.resolve(successResult(["ok"]));
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).resolves.toEqual(["ok"]);
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("does NOT retry a non-transient pre-token failure; the error surfaces to the consumer", async () => {
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) =>
      Promise.resolve(
        emptyErroredResult(args.onError, { message: "invalid request: bad schema", status: 400 })
      )
    );

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).rejects.toMatchObject({
      message: "invalid request: bad schema",
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("retries a transient pre-token failure on the streamStructured fullStream path", async () => {
    let call = 0;
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) => {
      call++;
      if (call === 1) {
        // The structured path consumes fullStream, so the transient error
        // must surface on THAT pull.
        return Promise.resolve({
          textStream: (async function* textStream() {})(),
          // biome-ignore lint/correctness/useYield: error-only stream fixture — the provider error surfaces via onError, no tokens.
          fullStream: (async function* fullStream() {
            args.onError({ error: TRANSIENT });
          })(),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
          finishReason: Promise.resolve("error"),
          usage: Promise.resolve(undefined),
        });
      }
      return Promise.resolve({
        textStream: (async function* textStream() {})(),
        fullStream: (async function* fullStream() {
          yield { type: "tool-input-start", id: "c1", toolName: "HANDLE_RESPONSE" };
          yield {
            type: "tool-input-delta",
            toolCallId: "c1",
            inputTextDelta: '{"replyText":"hi"}',
          };
          yield { type: "tool-input-end", id: "c1" };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([{ toolName: "HANDLE_RESPONSE", input: { replyText: "hi" } }]),
        finishReason: Promise.resolve("tool-calls"),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 8 }),
      });
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "stage-1",
      stream: true,
      streamStructured: true,
      toolChoice: "required",
    } as never)) as { textStream: AsyncIterable<string>; text: Promise<string> };

    await expect(collect(stream)).resolves.toEqual(['{"replyText":"hi"}']);
    await expect(stream.text).resolves.toBe('{"replyText":"hi"}');
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("non-streaming: a transient generateText rejection retries and returns the second attempt", async () => {
    let call = 0;
    aiMocks.generateText.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.reject(TRANSIENT);
      return Promise.resolve({
        text: "recovered",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 4, outputTokens: 2 },
        providerMetadata: undefined,
      });
    });

    const { handleTextSmall } = await import("../models/text");
    const result = await handleTextSmall(createRuntime(), { prompt: "hi" } as never);

    expect(result).toBe("recovered");
    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("non-streaming: a genuine validation 400 does not retry", async () => {
    aiMocks.generateText.mockRejectedValue({
      statusCode: 400,
      message: "invalid request: required field missing",
    });

    const { handleTextSmall } = await import("../models/text");
    await expect(handleTextSmall(createRuntime(), { prompt: "hi" } as never)).rejects.toMatchObject(
      { statusCode: 400 }
    );
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("buffered planner stream (FULL_ACTION_SURFACE): transient failure retries and replays the buffered text", async () => {
    process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
    try {
      let call = 0;
      // consumeStreamWithTransientRetry does not await streamText — return
      // plain result objects, not promises.
      aiMocks.streamText.mockImplementation(
        (args: { onError: (a: { error: unknown }) => void }) => {
          call++;
          if (call === 1) {
            return {
              // biome-ignore lint/correctness/useYield: error-only stream fixture — the provider error surfaces via onError, no tokens.
              textStream: (async function* textStream() {
                args.onError({ error: TRANSIENT });
              })(),
              toolCalls: Promise.resolve([]),
              finishReason: Promise.resolve("error"),
              usage: Promise.resolve(undefined),
            };
          }
          return {
            textStream: (async function* textStream() {
              yield "planned ";
              yield "output";
            })(),
            toolCalls: Promise.resolve([]),
            finishReason: Promise.resolve("stop"),
            usage: Promise.resolve({ inputTokens: 9, outputTokens: 3 }),
          };
        }
      );

      const { handleTextSmall } = await import("../models/text");
      const stream = (await handleTextSmall(createRuntime(), {
        prompt: "plan",
        stream: true,
      } as never)) as { textStream: AsyncIterable<string>; text: Promise<string> };

      await expect(collect(stream)).resolves.toEqual(["planned output"]);
      await expect(stream.text).resolves.toBe("planned output");
      expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
    }
  }, 20_000);

  it("buffered transformed planner stream replays only restored final text without the env gate", async () => {
    delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
    const wireText = JSON.stringify({
      thought: "Need a tool.",
      toolCalls: [
        {
          id: "call-1",
          name: "CALENDAR",
          args: {
            __eliza_planner_arg_entries: [
              { key: "action", valueJson: JSON.stringify("create") },
              { key: "durationMinutes", valueJson: JSON.stringify(30) },
            ],
          },
        },
      ],
    });
    const rawChunks = [wireText.slice(0, 24), wireText.slice(24)];
    aiMocks.streamText.mockImplementation(() => successResult(rawChunks));

    const onStreamChunk = vi.fn();
    const { handleActionPlanner } = await import("../models/text");
    const stream = (await handleActionPlanner(createRuntime(), {
      messages: [{ role: "user", content: "Plan" }],
      responseSchema: plannerResponseSchema(),
      stream: true,
      onStreamChunk,
    } as never)) as { textStream: AsyncIterable<string>; text: Promise<string> };

    const restoredText = JSON.stringify({
      thought: "Need a tool.",
      toolCalls: [
        {
          id: "call-1",
          name: "CALENDAR",
          args: { action: "create", durationMinutes: 30 },
        },
      ],
    });
    await expect(collect(stream)).resolves.toEqual([restoredText]);
    await expect(stream.text).resolves.toBe(restoredText);
    expect(onStreamChunk).toHaveBeenCalledTimes(1);
    expect(onStreamChunk).toHaveBeenCalledWith(restoredText);
    expect(onStreamChunk).not.toHaveBeenCalledWith(rawChunks[0]);
    expect(onStreamChunk).not.toHaveBeenCalledWith(rawChunks[1]);
  }, 20_000);

  it("non-streaming with native tools (the coding-build path): transient failure retries and tool calls survive", async () => {
    let call = 0;
    aiMocks.generateText.mockImplementation(() => {
      call++;
      // Cerebras's overload wears an HTTP 400 with transient wording on this
      // path — the exact #16334 scenario.
      if (call === 1) {
        return Promise.reject({
          statusCode: 400,
          message: "Encountered a server error, please try again",
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{ toolName: "lookup", input: { q: "answer" } }],
        finishReason: "tool-calls",
        usage: { inputTokens: 12, outputTokens: 6 },
        providerMetadata: undefined,
      });
    });

    const { handleTextSmall } = await import("../models/text");
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "call a tool",
      tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
      toolChoice: { type: "tool", toolName: "lookup" },
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    } as never)) as { toolCalls?: Array<{ toolName: string }> };

    expect(result.toolCalls?.[0]?.toolName).toBe("lookup");
    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("does NOT retry once a token has been delivered — mid-stream failures stay fatal", async () => {
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) =>
      Promise.resolve({
        textStream: (async function* textStream() {
          yield "partial ";
          args.onError({ error: TRANSIENT });
        })(),
        fullStream: (async function* fullStream() {})(),
        text: Promise.resolve("partial "),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve(undefined),
      })
    );

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).rejects.toMatchObject({
      message: "Encountered a server error, please try again",
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe("transient retry: abort-aware backoff", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("CEREBRAS_API_KEY", undefined);
    vi.stubEnv("ELIZA_PROVIDER", undefined);
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stream-start lane: abort mid-backoff rejects with the abort reason and no further streamText call ever fires", async () => {
    const controller = new AbortController();
    // Every attempt fails transiently, so only the abort can end the loop.
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) =>
      Promise.resolve(emptyErroredResult(args.onError, TRANSIENT))
    );

    const { handleTextSmall } = await import("../models/text");
    const pending = handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
      signal: controller.signal,
    } as never);
    // The first attempt fails within microtasks; the minimum backoff is 300ms,
    // so an 80ms abort lands inside the delay.
    setTimeout(() => controller.abort(new Error("cancelled mid-backoff")), 80);

    await expect(pending).rejects.toMatchObject({ message: "cancelled mid-backoff" });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    // Past the first retry's maximum backoff (300ms + 200ms jitter): a retry
    // scheduled despite the abort would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("stream-start lane: a signal already aborted at classification time blocks the retry even for a transient error", async () => {
    const controller = new AbortController();
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) => {
      // Cancellation racing the in-flight attempt: aborted before the retry
      // decision runs.
      controller.abort();
      return Promise.resolve(emptyErroredResult(args.onError, TRANSIENT));
    });

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
      signal: controller.signal,
    } as never)) as { textStream: AsyncIterable<string> };

    await expect(collect(stream)).rejects.toMatchObject({
      message: "Encountered a server error, please try again",
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("generate lane: abort mid-backoff rejects the non-streaming call and stops retrying", async () => {
    const controller = new AbortController();
    aiMocks.generateText.mockImplementation(() => Promise.reject(TRANSIENT));

    const { handleTextSmall } = await import("../models/text");
    const pending = handleTextSmall(createRuntime(), {
      prompt: "hi",
      signal: controller.signal,
    } as never);
    setTimeout(() => controller.abort(new Error("cancelled mid-backoff")), 80);

    await expect(pending).rejects.toMatchObject({ message: "cancelled mid-backoff" });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("buffered-stream lane: abort mid-backoff rejects the planner call and stops retrying", async () => {
    process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
    try {
      const controller = new AbortController();
      // consumeStreamWithTransientRetry does not await streamText — return
      // plain result objects, not promises.
      aiMocks.streamText.mockImplementation(
        (args: { onError: (a: { error: unknown }) => void }) => ({
          // biome-ignore lint/correctness/useYield: error-only stream fixture — the provider error surfaces via onError, no tokens.
          textStream: (async function* textStream() {
            args.onError({ error: TRANSIENT });
          })(),
          toolCalls: Promise.resolve([]),
          finishReason: Promise.resolve("error"),
          usage: Promise.resolve(undefined),
        })
      );

      const { handleTextSmall } = await import("../models/text");
      const pending = handleTextSmall(createRuntime(), {
        prompt: "plan",
        stream: true,
        signal: controller.signal,
      } as never);
      setTimeout(() => controller.abort(new Error("cancelled mid-backoff")), 80);

      await expect(pending).rejects.toMatchObject({ message: "cancelled mid-backoff" });
      expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
    }
  }, 20_000);
});

describe("transient retry: concurrency is bounded per stream", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("CEREBRAS_API_KEY", undefined);
    vi.stubEnv("ELIZA_PROVIDER", undefined);
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("three simultaneous streams each retrying once stay independent: two attempts per stream, six total, no cross-talk", async () => {
    const attemptsByPrompt = new Map<string, number>();
    aiMocks.streamText.mockImplementation(
      (args: { prompt?: string; onError: (a: { error: unknown }) => void }) => {
        const prompt = args.prompt ?? "<missing>";
        const attempt = (attemptsByPrompt.get(prompt) ?? 0) + 1;
        attemptsByPrompt.set(prompt, attempt);
        return Promise.resolve(
          attempt === 1 ? emptyErroredResult(args.onError, TRANSIENT) : successResult([prompt])
        );
      }
    );

    const { handleTextSmall } = await import("../models/text");
    const prompts = ["stream-a", "stream-b", "stream-c"];
    const streams = (await Promise.all(
      prompts.map((prompt) => handleTextSmall(createRuntime(), { prompt, stream: true } as never))
    )) as Array<{
      textStream: AsyncIterable<string>;
      providerMetadata?: { retryCount?: number };
    }>;

    const texts = await Promise.all(streams.map((stream) => collect(stream)));
    // Each stream delivers ITS OWN retried text — a cross-amplified retry
    // would either duplicate attempts or leak another stream's tokens.
    expect(texts).toEqual([["stream-a"], ["stream-b"], ["stream-c"]]);
    expect(aiMocks.streamText).toHaveBeenCalledTimes(6);
    for (const prompt of prompts) {
      expect(attemptsByPrompt.get(prompt)).toBe(2);
    }
    for (const stream of streams) {
      expect(stream.providerMetadata?.retryCount).toBe(1);
    }
  }, 30_000);
});

describe("transient retry: observability", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("CEREBRAS_API_KEY", undefined);
    vi.stubEnv("ELIZA_PROVIDER", undefined);
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function findModelUsedPayload(runtime: { emitEvent: ReturnType<typeof vi.fn> }) {
    const call = runtime.emitEvent.mock.calls.find(([event]) => event === EventType.MODEL_USED);
    return call?.[1] as
      | { retryCount?: number; lastRetryReason?: string; model?: string }
      | undefined;
  }

  it("a retried stream exposes retryCount/lastRetryReason on MODEL_USED, providerMetadata, and the structured warn", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    let call = 0;
    aiMocks.streamText.mockImplementation((args: { onError: (a: { error: unknown }) => void }) => {
      call++;
      return Promise.resolve(
        call <= 2 ? emptyErroredResult(args.onError, TRANSIENT) : successResult(["ok"])
      );
    });

    const runtime = {
      character: { name: "Ada", system: "system prompt" },
      emitEvent: vi.fn(),
      getService: vi.fn(() => null),
      getServicesByType: vi.fn(() => []),
      getSetting: vi.fn(() => undefined),
    };
    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(
      runtime as never,
      {
        prompt: "hi",
        stream: true,
      } as never
    )) as {
      textStream: AsyncIterable<string>;
      providerMetadata?: { retryCount?: number; lastRetryReason?: string };
    };
    await expect(collect(stream)).resolves.toEqual(["ok"]);

    expect(stream.providerMetadata).toMatchObject({
      retryCount: 2,
      lastRetryReason: expect.stringContaining("server error"),
    });
    const payload = findModelUsedPayload(runtime);
    expect(payload).toMatchObject({
      retryCount: 2,
      lastRetryReason: expect.stringContaining("server error"),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "plugin-openai",
        lane: "stream-start",
        attempt: 1,
        maxRetries: 5,
        model: expect.any(String),
        reason: expect.stringContaining("server error"),
      }),
      expect.any(String)
    );
  }, 30_000);

  it("a clean first-attempt stream reports retryCount 0 and no lastRetryReason", async () => {
    aiMocks.streamText.mockImplementation(() => Promise.resolve(successResult(["ok"])));

    const runtime = {
      character: { name: "Ada", system: "system prompt" },
      emitEvent: vi.fn(),
      getService: vi.fn(() => null),
      getServicesByType: vi.fn(() => []),
      getSetting: vi.fn(() => undefined),
    };
    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(
      runtime as never,
      {
        prompt: "hi",
        stream: true,
      } as never
    )) as {
      textStream: AsyncIterable<string>;
      providerMetadata?: { retryCount?: number; lastRetryReason?: string };
    };
    await expect(collect(stream)).resolves.toEqual(["ok"]);

    expect(stream.providerMetadata?.retryCount).toBe(0);
    expect(stream.providerMetadata).not.toHaveProperty("lastRetryReason");
    const payload = findModelUsedPayload(runtime);
    expect(payload?.retryCount).toBe(0);
    expect(payload).not.toHaveProperty("lastRetryReason");
  }, 20_000);

  it("a retried non-streaming native call surfaces retry telemetry on MODEL_USED and result providerMetadata", async () => {
    let call = 0;
    aiMocks.generateText.mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.reject({
          statusCode: 400,
          message: "Encountered a server error, please try again",
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{ toolName: "lookup", input: { q: "answer" } }],
        finishReason: "tool-calls",
        usage: { inputTokens: 12, outputTokens: 6 },
        providerMetadata: undefined,
      });
    });

    const runtime = {
      character: { name: "Ada", system: "system prompt" },
      emitEvent: vi.fn(),
      getService: vi.fn(() => null),
      getServicesByType: vi.fn(() => []),
      getSetting: vi.fn(() => undefined),
    };
    const { handleTextSmall } = await import("../models/text");
    const result = (await handleTextSmall(
      runtime as never,
      {
        prompt: "call a tool",
        tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
        toolChoice: { type: "tool", toolName: "lookup" },
      } as never
    )) as {
      providerMetadata?: { retryCount?: number; lastRetryReason?: string };
    };

    expect(result.providerMetadata).toMatchObject({
      retryCount: 1,
      lastRetryReason: expect.stringContaining("server error"),
    });
    const payload = findModelUsedPayload(runtime);
    expect(payload).toMatchObject({
      retryCount: 1,
      lastRetryReason: expect.stringContaining("server error"),
    });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);
  }, 20_000);
});
