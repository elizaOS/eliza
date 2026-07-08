/**
 * Shape tests for streamStructured tool-input-delta forwarding: structured
 * Stage-1 calls force the response envelope out as a native tool call, and the
 * AI SDK's `textStream` drops tool-input deltas — so with `streamStructured`
 * the handler must consume `fullStream` and forward only tool-input-delta parts.
 * Mocked `ai` SDK (fresh stream objects per call via mockImplementation —
 * generators are single-use), no network; the live trajectory evidence rides
 * the PR.
 */
import { describe, expect, it, vi } from "vitest";

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

/**
 * Fresh result per call — generators are single-use, so sharing one object
 * across streamText invocations interleaves/starves consumers.
 */
function armToolForcedStream(opts?: { alsoText?: boolean }) {
  aiMocks.streamText.mockImplementation(() =>
    Promise.resolve({
      textStream: (async function* textStream() {
        // Tool-forced responses carry no text-delta parts — this stays empty,
        // which is exactly the bug: nothing streams on the default path.
      })(),
      fullStream: (async function* fullStream() {
        if (opts?.alsoText) {
          yield { type: "text-delta", id: "t1", delta: "pre" };
        }
        yield {
          type: "tool-input-start",
          id: "c1",
          toolName: "HANDLE_RESPONSE",
        };
        yield {
          type: "tool-input-delta",
          toolCallId: "c1",
          inputTextDelta: '{"replyText":"',
        };
        yield {
          type: "tool-input-delta",
          toolCallId: "c1",
          inputTextDelta: "hello",
        };
        // Alternate v6-minor spelling (`delta` instead of `inputTextDelta`) —
        // the forwarder must survive either resolution of the ai package.
        yield { type: "tool-input-delta", id: "c1", delta: '"}' };
        yield { type: "tool-input-end", id: "c1" };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([{ toolName: "HANDLE_RESPONSE", input: { replyText: "hello" } }]),
      finishReason: Promise.resolve("tool-calls"),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 8 }),
    })
  );
}

async function collect(stream: { textStream: AsyncIterable<string> }) {
  const chunks: string[] = [];
  for await (const chunk of stream.textStream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("streamStructured tool-input-delta forwarding", () => {
  it("streamStructured=true: tool-input deltas stream while preceding text-deltas stay hidden", async () => {
    armToolForcedStream({ alsoText: true });

    const onStreamChunk = vi.fn();
    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "stage-1",
      stream: true,
      streamStructured: true,
      toolChoice: "required",
      onStreamChunk,
    } as never)) as {
      textStream: AsyncIterable<string>;
      toolCalls?: Promise<unknown>;
    };

    const chunks = await collect(stream);

    expect(chunks).toEqual(['{"replyText":"', "hello", '"}']);
    expect(onStreamChunk).toHaveBeenCalledTimes(3);
    expect(chunks.join("")).not.toContain("pre");
    // The authoritative envelope still arrives via the completed toolCalls.
    await expect(stream.toolCalls).resolves.toEqual([
      { toolName: "HANDLE_RESPONSE", input: { replyText: "hello" } },
    ]);
  }, 20_000);

  it("streamStructured=true: non-delta fullStream parts (start/end/finish) are filtered out", async () => {
    armToolForcedStream();

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "stage-1",
      stream: true,
      streamStructured: true,
      toolChoice: "required",
    } as never)) as { textStream: AsyncIterable<string> };

    const chunks = await collect(stream);

    expect(chunks.join("")).toBe('{"replyText":"hello"}');
    expect(chunks.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  }, 20_000);

  it("without streamStructured: textStream path is used and fullStream is never consumed", async () => {
    let fullStreamTouched = false;
    aiMocks.streamText.mockImplementation(() =>
      Promise.resolve({
        textStream: (async function* textStream() {
          yield "hel";
          yield "lo";
        })(),
        fullStream: (async function* fullStream() {
          fullStreamTouched = true;
          yield { type: "text-delta", id: "t1", delta: "never" };
        })(),
        text: Promise.resolve("hello"),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }),
      })
    );

    const { handleTextSmall } = await import("../models/text");
    const stream = (await handleTextSmall(createRuntime(), {
      prompt: "plain stream",
      stream: true,
    } as never)) as { textStream: AsyncIterable<string> };

    const chunks = await collect(stream);

    expect(chunks).toEqual(["hel", "lo"]);
    expect(fullStreamTouched).toBe(false);
  }, 20_000);
});
