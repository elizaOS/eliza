/** Runs the real SDK stream and route settlement with local search-error SSE fixtures. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
const previousKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = "sk-local-search-abort-regression";

const MODEL = "claude-sonnet-4-6";
let closeDb: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
  const { pushSchemaToTestDb } = await import(
    "../../shared/src/db/push-schema-for-tests"
  );
  const { aiPricingEntries } = await import(
    "../../shared/src/db/schemas/ai-pricing"
  );
  await pushSchemaToTestDb({ aiPricingEntries });
  const { aiPricingRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/ai-pricing"
  );
  for (const [chargeType, unitPrice] of [
    ["input", 3e-6],
    ["output", 15e-6],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "bitrouter",
      provider: "anthropic",
      model: `anthropic/${MODEL}`,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: isolated prices",
      updatedBy: "test",
    });
  }
});

afterAll(async () => {
  await closeDb?.();
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

test("a failed server search followed by abort retains unknown settlement, not a search charge", async () => {
  const { __streamingCreditTestHooks } = await import(
    "../v1/chat/completions/route"
  );
  const { buildProviderNativeWebSearchTools } = await import(
    "@elizaos/cloud-shared/lib/providers/anthropic-web-search"
  );
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let requests = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    requests += 1;
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const frames = [
            {
              type: "message_start",
              message: {
                id: "msg_search_abort",
                type: "message",
                role: "assistant",
                model: MODEL,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "server_tool_use",
                id: "srvtoolu_failed",
                name: "web_search",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '{"query":"test query"}',
              },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_failed",
                content: {
                  type: "web_search_tool_result_error",
                  error_code: "unavailable",
                },
              },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "content_block_start",
              index: 2,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 2,
              delta: {
                type: "text_delta",
                text: "The search failed.",
              },
            },
          ];
          for (const frame of frames) {
            controller.enqueue(
              encoder.encode(
                `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
              ),
            );
          }
          // No final usage arrives. The caller cancels after it receives text.
          signal?.addEventListener(
            "abort",
            () => controller.error(signal?.reason),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
  const exactCharges: number[] = [];
  let unknownSettlements = 0;
  const settled = Promise.withResolvers<void>();
  try {
    const response = await __streamingCreditTestHooks.handleStreamingRequest(
      `anthropic/${MODEL}`,
      undefined,
      [{ role: "user", content: "Search the web." }],
      {
        model: `anthropic/${MODEL}`,
        messages: [{ role: "user", content: "Search the web." }],
        stream: true,
        webSearchEnabled: true,
        webSearchMaxUses: 5,
      },
      {
        id: "00000000-0000-0000-0000-00000000d002",
        organization_id: "00000000-0000-0000-0000-00000000d001",
      },
      null,
      null,
      "search-abort",
      "search-abort",
      null,
      Date.now(),
      abort.signal,
      10_000,
      10_100,
      async (amount) => {
        exactCharges.push(amount);
        settled.resolve();
        return null;
      },
      async () => {
        unknownSettlements += 1;
        settled.resolve();
        return null;
      },
      undefined,
      {},
      100,
      buildProviderNativeWebSearchTools({
        provider: "anthropic",
        model: MODEL,
        enabled: true,
        maxUses: 5,
      }),
      "bitrouter",
      null,
      false,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let output = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
      if (output.includes("The search failed.")) abort.abort();
    }
    await settled.promise;
    expect(requests).toBe(1);
    expect(output).toContain("srvtoolu_failed");
    expect(output).toContain("The search failed.");
    expect(exactCharges).toEqual([]);
    expect(unknownSettlements).toBe(1);
  } finally {
    abort.abort();
    fetchSpy.mockRestore();
  }
});

/** Tool-use input the provider streams before the client disconnects. */
const ESSAY = "word ".repeat(40_000); // 200k characters, about 50k tokens
const TOOL_INPUT_JSON = JSON.stringify({ text: ESSAY });
/** `text` in 20 streamed fragments. */
function fragments(text: string): string[] {
  const size = Math.ceil(text.length / 20);
  return Array.from({ length: 20 }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
}
const AFTER_TOOL = "AFTER-TOOL";

/**
 * How the provider delivers the tool input before the client disconnects:
 * - `open`: streamed fragments; the tool input never closes.
 * - `complete`: streamed fragments, the tool call completes, then text.
 * - `final-only`: no fragments; the whole input is in the completed tool call,
 *   then text.
 */
type ToolInputMode = "open" | "complete" | "final-only";

/** The text the client has when it disconnects, and the marker it waits for. */
function deliveredOutput(mode: ToolInputMode): {
  marker: string;
  chars: number;
} {
  if (mode === "open") {
    return {
      marker: "LAST-FRAGMENT",
      chars: TOOL_INPUT_JSON.length - 2 + "LAST-FRAGMENT".length,
    };
  }
  return {
    marker: AFTER_TOOL,
    chars: TOOL_INPUT_JSON.length + AFTER_TOOL.length,
  };
}

/**
 * The exact abort charge: the estimated input plus the delivered output, at
 * the isolated prices with the platform markup. A doubled tool input fails
 * this check.
 */
async function expectedAbortCharge(mode: ToolInputMode): Promise<number> {
  const { PLATFORM_MARKUP_MULTIPLIER } = await import(
    "@elizaos/cloud-shared/lib/pricing"
  );
  const outputTokens = Math.ceil(deliveredOutput(mode).chars / 4);
  return (100 * 3e-6 + outputTokens * 15e-6) * PLATFORM_MARKUP_MULTIPLIER;
}

function mockToolInputStream(mode: ToolInputMode) {
  const encoder = new TextEncoder();
  return spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const frames: unknown[] = [
            {
              type: "message_start",
              message: {
                id: `msg_tool_abort_${mode}`,
                type: "message",
                role: "assistant",
                model: MODEL,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_essay",
                name: "write_essay",
                input: mode === "final-only" ? { text: ESSAY } : {},
              },
            },
          ];
          const inputDelta = (partial_json: string) => ({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json },
          });
          if (mode === "open") {
            // The input without its closing `"}`, then a last fragment.
            for (const fragment of fragments(TOOL_INPUT_JSON.slice(0, -2))) {
              frames.push(inputDelta(fragment));
            }
            frames.push(inputDelta("LAST-FRAGMENT"));
          } else {
            if (mode === "complete") {
              for (const fragment of fragments(TOOL_INPUT_JSON)) {
                frames.push(inputDelta(fragment));
              }
            }
            frames.push(
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start",
                index: 1,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 1,
                delta: { type: "text_delta", text: AFTER_TOOL },
              },
            );
          }
          for (const frame of frames) {
            const type = (frame as { type: string }).type;
            controller.enqueue(
              encoder.encode(
                `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`,
              ),
            );
          }
          // The message never finishes. The caller disconnects first.
          signal?.addEventListener(
            "abort",
            () => controller.error(signal?.reason),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
}

async function readUntilThenAbort(
  response: Response,
  marker: string,
  abort: AbortController,
): Promise<string> {
  const reader = response.body!.getReader();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    if (output.includes(marker)) abort.abort();
  }
  return output;
}

for (const mode of ["open", "complete", "final-only"] as const) {
  test(`/v1/chat/completions: an abort after ${mode} tool arguments bills them once`, async () => {
    const { __streamingCreditTestHooks } = await import(
      "../v1/chat/completions/route"
    );
    const abort = new AbortController();
    const fetchSpy = mockToolInputStream(mode);
    const exactCharges: number[] = [];
    let unknownSettlements = 0;
    const settled = Promise.withResolvers<void>();
    try {
      const response = await __streamingCreditTestHooks.handleStreamingRequest(
        `anthropic/${MODEL}`,
        undefined,
        [{ role: "user", content: "Put a long essay in text." }],
        {
          model: `anthropic/${MODEL}`,
          messages: [{ role: "user", content: "Put a long essay in text." }],
          stream: true,
          max_tokens: 64_000,
          tools: [
            {
              type: "function",
              function: {
                name: "write_essay",
                parameters: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "write_essay" } },
        },
        {
          id: "00000000-0000-0000-0000-00000000d012",
          organization_id: "00000000-0000-0000-0000-00000000d011",
        },
        null,
        null,
        `tool-abort-completions-${mode}`,
        `tool-abort-completions-${mode}`,
        null,
        Date.now(),
        abort.signal,
        10_000,
        100,
        async (amount) => {
          exactCharges.push(amount);
          settled.resolve();
          return null;
        },
        async () => {
          unknownSettlements += 1;
          settled.resolve();
          return null;
        },
        undefined,
        {},
        64_000,
        {},
        "bitrouter",
        null,
        false,
      );
      expect(response.status).toBe(200);
      const { marker } = deliveredOutput(mode);
      const output = await readUntilThenAbort(response, marker, abort);
      await settled.promise;
      expect(output).toContain(marker);
      expect(unknownSettlements).toBe(0);
      expect(exactCharges).toHaveLength(1);
      // The client received about 50k tokens of tool arguments, once.
      expect(exactCharges[0]).toBeCloseTo(await expectedAbortCharge(mode), 9);
    } finally {
      abort.abort();
      fetchSpy.mockRestore();
    }
  });

  test(`/v1/messages: an abort after ${mode} tool input bills it once`, async () => {
    const { __messagesStreamingCreditTestHooks } = await import(
      "../v1/messages/route"
    );
    const { jsonSchema } = await import("ai");
    const abort = new AbortController();
    const fetchSpy = mockToolInputStream(mode);
    const exactCharges: number[] = [];
    let unknownSettlements = 0;
    const settled = Promise.withResolvers<void>();
    const inputSchema = {
      type: "object" as const,
      properties: { text: { type: "string" as const } },
      required: ["text"],
    };
    try {
      const response = await __messagesStreamingCreditTestHooks.handleStream(
        `anthropic/${MODEL}`,
        undefined,
        [{ role: "user", content: "Put a long essay in text." }],
        {
          model: `anthropic/${MODEL}`,
          max_tokens: 64_000,
          stream: true,
          messages: [{ role: "user", content: "Put a long essay in text." }],
          tools: [{ name: "write_essay", input_schema: inputSchema }],
          tool_choice: { type: "tool", name: "write_essay" },
        },
        {
          id: "00000000-0000-0000-0000-00000000d022",
          organization_id: "00000000-0000-0000-0000-00000000d021",
        },
        null,
        null,
        Date.now(),
        100,
        {},
        {
          write_essay: {
            inputSchema: jsonSchema(inputSchema),
            outputSchema: jsonSchema({
              type: "object",
              additionalProperties: true,
            }),
          },
        },
        { type: "tool", toolName: "write_essay" },
        abort.signal,
        10_000,
        async (amount) => {
          exactCharges.push(amount);
          settled.resolve();
          return null;
        },
        async () => {
          unknownSettlements += 1;
          settled.resolve();
          return null;
        },
        undefined,
        "bitrouter",
        `tool-abort-messages-${mode}`,
      );
      expect(response.status).toBe(200);
      const { marker } = deliveredOutput(mode);
      const output = await readUntilThenAbort(response, marker, abort);
      await settled.promise;
      expect(output).toContain(marker);
      expect(unknownSettlements).toBe(0);
      expect(exactCharges).toHaveLength(1);
      expect(exactCharges[0]).toBeCloseTo(await expectedAbortCharge(mode), 9);
    } finally {
      abort.abort();
      fetchSpy.mockRestore();
    }
  });
}
