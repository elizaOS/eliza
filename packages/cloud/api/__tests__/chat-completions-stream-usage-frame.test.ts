/**
 * OpenAI stream_options.include_usage contract for POST /api/v1/chat/completions
 * streaming: a terminal usage-only chunk (empty choices) before `data: [DONE]`,
 * `usage: null` on every other chunk, nothing when not requested, and never a
 * fabricated usage frame when the SDK reported none. Drives the REAL streaming
 * handler and asserts on the raw SSE bytes; only `streamText` (the provider
 * boundary) is substituted, mirroring chat-completions-streaming-credit-leak.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import * as languageModelActual from "@/lib/providers/language-model";

let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  streamText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const { __streamingCreditTestHooks } = await import(
  "../v1/chat/completions/route"
);
const { handleStreamingRequest } = __streamingCreditTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "openai/gpt-oss-120b";

function callStreaming(request: Record<string, unknown>) {
  return handleStreamingRequest(
    MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    request as never,
    { id: USER, organization_id: ORG },
    null,
    null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    undefined,
    30_000,
    1,
    (async () => null) as never,
    {} as never,
    undefined,
    {} as never,
    "gateway" as never,
    null,
    false,
  );
}

async function collectJsonFrames(res: Response) {
  const body = await res.text();
  const dataLines = body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length).trim());
  const jsonFrames = dataLines
    .filter((d) => d && d !== "[DONE]")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
  return { body, dataLines, jsonFrames };
}

const FINISH_USAGE = {
  inputTokens: 72,
  outputTokens: 60,
  totalTokens: 132,
  inputTokenDetails: { cacheReadTokens: 7 },
};

function streamTextDoubleWithFinish(totalUsage: unknown) {
  streamTextImpl = () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", id: "text-1", text: "ok" };
      yield {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        ...(totalUsage !== undefined ? { totalUsage } : {}),
      };
    })(),
  });
}

beforeEach(() => {
  streamText.mockClear();
  streamTextImpl = null;
});

describe("streaming chat — stream_options.include_usage usage frame", () => {
  test("terminal usage-only chunk carries the SDK's real token usage before [DONE]", async () => {
    streamTextDoubleWithFinish(FINISH_USAGE);

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { dataLines, jsonFrames } = await collectJsonFrames(res);

    // Stream still terminates correctly.
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    // The last JSON frame is the usage-only chunk: empty choices, real usage.
    const usageChunk = jsonFrames[jsonFrames.length - 1];
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toMatchObject({
      prompt_tokens: 72,
      completion_tokens: 60,
      total_tokens: 132,
      prompt_tokens_details: { cached_tokens: 7 },
    });

    // The finish_reason chunk still precedes it, and every non-terminal chunk
    // carries usage: null per the OpenAI contract.
    const finishChunk = jsonFrames[jsonFrames.length - 2] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finishChunk.choices[0].finish_reason).toBe("stop");
    for (const frame of jsonFrames.slice(0, -1)) {
      expect("usage" in frame).toBe(true);
      expect(frame.usage).toBeNull();
    }
  });

  test("without stream_options no chunk carries a usage field (OpenAI default)", async () => {
    streamTextDoubleWithFinish(FINISH_USAGE);

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const { dataLines, jsonFrames } = await collectJsonFrames(res);

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    for (const frame of jsonFrames) {
      expect("usage" in frame).toBe(false);
    }
    const finalChunk = jsonFrames[jsonFrames.length - 1] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
  });

  test("no usage frame is fabricated when the finish part reports no usage", async () => {
    streamTextDoubleWithFinish(undefined);

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { dataLines, jsonFrames } = await collectJsonFrames(res);

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    // Chunks still carry usage: null, but no terminal chunk invents token
    // counts the SDK never reported ("not loaded" must never read as zero).
    for (const frame of jsonFrames) {
      expect(frame.usage ?? null).toBeNull();
    }
    const finalChunk = jsonFrames[jsonFrames.length - 1] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
  });

  test("empty usage objects do not fabricate a zero-token usage frame", async () => {
    streamTextDoubleWithFinish({});

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { jsonFrames } = await collectJsonFrames(res);

    for (const frame of jsonFrames) {
      expect(frame.usage ?? null).toBeNull();
    }
    const finalChunk = jsonFrames[jsonFrames.length - 1] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
  });

  test("mid-stream provider error emits the terminal error chunk, never a usage frame", async () => {
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", id: "text-1", text: "partial" };
        yield { type: "error", error: new Error("provider exploded") };
      })(),
    });

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { dataLines, jsonFrames } = await collectJsonFrames(res);

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    const errorChunk = jsonFrames.find((f) => "error" in f);
    expect(errorChunk).toBeDefined();
    for (const frame of jsonFrames) {
      expect(frame.usage ?? null).toBeNull();
    }
  });
});
