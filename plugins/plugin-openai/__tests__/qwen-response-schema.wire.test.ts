/**
 * Exercises Qwen response-schema serialization through the real AI SDK and
 * provider client against a loopback HTTP endpoint. No live provider is used;
 * schema enforcement is asserted on the request, not simulated model behavior.
 */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { jsonSchema, Output } from "ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatorSchema } from "../../../packages/core/src/prompts/evaluator";
import { handleActionPlanner, handleTextSmall } from "../models/text";

interface WireRequest {
  model: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  response_format?: {
    type: string;
    json_schema?: { strict: boolean; schema: Record<string, unknown> };
  };
}

const verdict = {
  thought: "The recorded navigation completed the request.",
  success: true,
  decision: "FINISH",
};
const requests: WireRequest[] = [];
let reply: unknown = verdict;
let baseUrl: string;
let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
      requests.push(body);
      const text = JSON.stringify(reply);
      const base = { id: "chatcmpl-qwen-fixture", created: 0, model: body.model };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const content of [text.substring(0, 12), text.substring(12)]) {
          response.write(
            `data: ${JSON.stringify({
              ...base,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`
          );
        }
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          })}\n\n`
        );
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requests.length = 0;
  reply = verdict;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => vi.unstubAllEnvs());

function runtime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
    character: { name: "Ada", system: "Preserve the complete caller context." },
    emitEvent: vi.fn(),
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

async function invoke(options: {
  schema?: unknown;
  stream?: boolean;
  model?: string;
  tools?: Array<{ name: string; description: string; parameters: object; strict: boolean }>;
  responseFormat?: { type: "json_object" };
  actionPlanner?: boolean;
  temperature?: number;
  topP?: number;
}) {
  const chunks: string[] = [];
  const handler = options.actionPlanner ? handleActionPlanner : handleTextSmall;
  const result: unknown = await handler(runtime(), {
    model: options.model ?? "qwen-3.8-27b",
    messages: [
      {
        role: "user",
        content: "Return JSON for the full navigation request; retain this final context marker.",
      },
    ],
    ...(options.schema ? { responseSchema: options.schema } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    stream: options.stream ?? false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    onStreamChunk: (chunk: string) => chunks.push(chunk),
  } as never);
  if (!result || typeof result !== "object" || !("text" in result)) {
    throw new Error("expected native text result");
  }
  if ("textStream" in result) {
    let text = "";
    for await (const chunk of result.textStream as AsyncIterable<string>) text += chunk;
    expect(chunks.join("")).toBe(text);
    expect(await result.text).toBe(text);
    return JSON.parse(text) as unknown;
  }
  if (typeof result.text !== "string") throw new Error("expected completed text");
  return JSON.parse(result.text) as unknown;
}

describe("Qwen3.8 response-schema wire contract", () => {
  it.each([false, true])(
    "preserves explicit sampling independently, including zero and omission (stream=%s)",
    async (stream) => {
      const samples: Array<{ temperature?: number; topP?: number }> = [
        {},
        { temperature: 0 },
        { topP: 0 },
        { temperature: 0.4, topP: 0.7 },
        {},
      ];
      for (const sample of samples) {
        expect(await invoke({ stream, ...sample })).toEqual(verdict);
        const sent = requests.at(-1);
        if (!sent) throw new Error("Expected outbound SDK request");
        if (sample.temperature === undefined) expect(sent).not.toHaveProperty("temperature");
        else expect(sent.temperature).toBe(sample.temperature);
        if (sample.topP === undefined) expect(sent).not.toHaveProperty("top_p");
        else expect(sent.top_p).toBe(sample.topP);
      }
      expect(requests).toHaveLength(samples.length);
    }
  );

  it.each([false, true])(
    "retains SDK omission for unsupported reasoning-model sampling (stream=%s)",
    async (stream) => {
      vi.stubEnv("ELIZA_PROVIDER", "openai");
      expect(await invoke({ stream, model: "o3", temperature: 0, topP: 0.7 })).toEqual(verdict);
      expect(requests).toHaveLength(1);
      expect(requests[0].model).toBe("o3");
      expect(requests[0]).not.toHaveProperty("temperature");
      expect(requests[0]).not.toHaveProperty("top_p");
    }
  );

  it.each([false, true])(
    "sends the actual evaluator schema strictly without requiring optional outputs (stream=%s)",
    async (stream) => {
      const original = structuredClone(evaluatorSchema);
      expect(await invoke({ schema: evaluatorSchema, stream, tools: [] })).toEqual(verdict);
      expect(requests).toHaveLength(1);
      expect(requests[0].response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: true,
          schema: evaluatorSchema,
        },
      });
      expect(requests[0].tools).toBeUndefined();
      expect(requests[0].messages).toContainEqual({
        role: "user",
        content: "Return JSON for the full navigation request; retain this final context marker.",
      });
      expect(evaluatorSchema).toEqual(original);
    }
  );

  it.each([
    ["another Cerebras model", { model: "gpt-oss-120b", schema: evaluatorSchema }],
    ["schema-less JSON", { responseFormat: { type: "json_object" as const } }],
    ["opaque SDK output", { schema: Output.object({ schema: jsonSchema(evaluatorSchema) }) }],
    [
      "native tools",
      {
        schema: evaluatorSchema,
        tools: [
          {
            name: "inspect",
            description: "Inspect state",
            strict: false,
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
  ])("keeps the existing JSON-mode contract for %s", async (_name, options) => {
    expect(await invoke(options)).toEqual(verdict);
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format).toEqual({ type: "json_object" });
  });

  it.each([
    ["root array", { type: "array", items: { type: "string" } }, ["preserved"]],
    ["root union", { anyOf: [{ type: "string" }, { type: "number" }] }, "preserved"],
    ["bare object", { type: "object" }, { customKey: "preserved" }],
    [
      "typeless root",
      { properties: { value: { type: "string" } }, additionalProperties: false },
      null,
    ],
    [
      "typeless nested object",
      {
        type: "object",
        properties: {
          value: { properties: { note: { type: "string" } }, additionalProperties: false },
        },
        additionalProperties: false,
      },
      { value: null },
    ],
    [
      "root object with implicit extra keys",
      {
        type: "object",
        properties: { known: { type: "string" } },
        required: ["known"],
      },
      { known: "preserved", extra: "also preserved" },
    ],
    [
      "nested object with implicit extra keys",
      {
        type: "object",
        properties: { metadata: { type: "object", properties: { known: { type: "string" } } } },
        required: ["metadata"],
        additionalProperties: false,
      },
      { metadata: { known: "preserved", extra: "also preserved" } },
    ],
    [
      "conditional schema",
      {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
        if: { properties: { value: { const: "preserved" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword, not a promise.
        then: { required: ["value"] },
      },
      { value: "preserved" },
    ],
    [
      "nested composition",
      {
        type: "object",
        properties: { value: { allOf: [{ type: "string" }, { const: "preserved" }] } },
        required: ["value"],
        additionalProperties: false,
      },
      { value: "preserved" },
    ],
    [
      "schema reference",
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: { type: "string" } },
        additionalProperties: false,
      },
      { value: "preserved" },
    ],
    [
      "open map",
      {
        type: "object",
        properties: { metadata: { type: "object", additionalProperties: { type: "string" } } },
        required: ["metadata"],
        additionalProperties: false,
      },
      { metadata: { customKey: "preserved" } },
    ],
    [
      "nullable object",
      {
        type: "object",
        properties: {
          metadata: {
            type: ["object", "null"],
            properties: { note: { type: "string" } },
            additionalProperties: false,
          },
        },
        required: ["metadata"],
        additionalProperties: false,
      },
      { metadata: null },
    ],
  ])("does not narrow the existing response shape for %s", async (_name, schema, result) => {
    reply = result;
    expect(await invoke({ schema })).toEqual(result);
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format).toEqual({ type: "json_object" });
  });

  it("preserves optional fields inside closed array items and unions after normalization", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" }, optional: { type: "string" } },
            required: ["value"],
          },
        },
        detail: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              properties: { optional: { type: "string" } },
            },
          ],
        },
      },
      required: ["rows"],
    };
    reply = { rows: [{ value: "preserved" }], detail: {} };
    expect(await invoke({ schema })).toEqual(reply);
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format?.json_schema).toEqual({
      name: "response",
      strict: true,
      schema,
    });
  });

  it("does not change the non-Cerebras schema normalization contract", async () => {
    vi.stubEnv("ELIZA_PROVIDER", undefined);
    expect(await invoke({ schema: evaluatorSchema })).toEqual(verdict);
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format?.json_schema?.schema.required).toEqual(
      Object.keys(evaluatorSchema.properties ?? {})
    );
  });

  it("preserves the existing schema-only planner argument representation", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        toolCalls: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              args: { type: "object", additionalProperties: true },
            },
            required: ["name", "args"],
          },
        },
      },
      required: ["toolCalls"],
    };
    reply = {
      toolCalls: [
        { name: "LOOKUP", args: { query: "exact input", metadata: { custom: "preserved" } } },
      ],
    };
    expect(await invoke({ schema, actionPlanner: true })).toEqual(reply);
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format).toEqual({ type: "json_object" });
  });
});
