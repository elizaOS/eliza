/**
 * Shape tests for live-stream start retry: a transient provider error that
 * kills the stream BEFORE its first token (Cerebras's "Encountered a server
 * error, please try again" arrives via `onError` with an empty stream, or as
 * a throw on the first pull) retries with backoff, because nothing has
 * reached the user yet. Mid-stream and non-transient failures stay fatal.
 * Mocked `ai` SDK (fresh stream objects per call — generators are single-use),
 * no network; the live Cerebras failure this fences rode the incident log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    aiMocks.streamText.mockReset();
    aiMocks.generateText.mockReset();
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
