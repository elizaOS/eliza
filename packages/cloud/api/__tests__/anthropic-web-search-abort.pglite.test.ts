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
const TOOL_INPUT_CHUNK = `{"text":"${"word ".repeat(2_000)}`;
const TOOL_INPUT_CHUNKS = 20; // about 200k characters, about 50k tokens
const TOOL_INPUT_TOKENS = Math.ceil(
  (TOOL_INPUT_CHUNK.length * TOOL_INPUT_CHUNKS) / 4,
);

/** A forced tool call whose input streams in large fragments and never finishes. */
function mockStreamedToolInput() {
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
                id: "msg_tool_abort",
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
                input: {},
              },
            },
          ];
          for (let i = 0; i < TOOL_INPUT_CHUNKS; i += 1) {
            frames.push({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json:
                  i === 0 ? TOOL_INPUT_CHUNK : TOOL_INPUT_CHUNK.slice(9),
              },
            });
          }
          frames.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "LAST-FRAGMENT" },
          });
          for (const frame of frames) {
            const type = (frame as { type: string }).type;
            controller.enqueue(
              encoder.encode(
                `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`,
              ),
            );
          }
          // The tool input never closes. The caller disconnects first.
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

test("/v1/chat/completions: an abort after streamed tool arguments bills those arguments", async () => {
  const { __streamingCreditTestHooks } = await import(
    "../v1/chat/completions/route"
  );
  const abort = new AbortController();
  const fetchSpy = mockStreamedToolInput();
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
      "tool-abort-completions",
      "tool-abort-completions",
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
    const output = await readUntilThenAbort(response, "LAST-FRAGMENT", abort);
    await settled.promise;
    expect(output).toContain("LAST-FRAGMENT");
    expect(unknownSettlements).toBe(0);
    expect(exactCharges).toHaveLength(1);
    // The client received about 50k tokens of tool arguments. The charge must
    // cover them, not only the 100 input tokens.
    expect(exactCharges[0]).toBeGreaterThanOrEqual(TOOL_INPUT_TOKENS * 15e-6);
  } finally {
    abort.abort();
    fetchSpy.mockRestore();
  }
});

test("/v1/messages: an abort after streamed tool input bills that input", async () => {
  const { __messagesStreamingCreditTestHooks } = await import(
    "../v1/messages/route"
  );
  const { jsonSchema } = await import("ai");
  const abort = new AbortController();
  const fetchSpy = mockStreamedToolInput();
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
      "tool-abort-messages",
    );
    expect(response.status).toBe(200);
    const output = await readUntilThenAbort(response, "LAST-FRAGMENT", abort);
    await settled.promise;
    expect(output).toContain("LAST-FRAGMENT");
    expect(unknownSettlements).toBe(0);
    expect(exactCharges).toHaveLength(1);
    expect(exactCharges[0]).toBeGreaterThanOrEqual(TOOL_INPUT_TOKENS * 15e-6);
  } finally {
    abort.abort();
    fetchSpy.mockRestore();
  }
});
