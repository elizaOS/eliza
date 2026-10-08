/**
 * Offline unit coverage for the native `/chat/completions` `response_format`
 * gate. The Cloud gateway 400s on `response_format` for its served models —
 * both `json_schema` and `json_object` (verified live against zai-glm-4.7 and
 * gemma-4-31b) — so the wire body must omit `response_format` entirely and
 * rely on the schema embedded in the prompt. Only an explicit caller-supplied
 * `responseFormat` override still reaches the wire.
 *
 * The fetch is mocked: we capture the request body and return a canned
 * chat-completions response, checking the actual schema, messages and format on the SDK HTTP request.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/host/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatorSchema } from "../../../plugin-assistant/src/prompts/evaluator";
import { generateNativeChatCompletion } from "../../src/models/text";

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;
function runtime(): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  };
  const fixture: RuntimeFixture = {
    character: { name: "Eliza", bio: [] },
    getSetting: (key: string) => settings[key] ?? null,
    emitEvent: vi.fn(),
  };
  return fixture as IAgentRuntime;
}
const RESPONSE_SCHEMA = {
  schema: {
    type: "object",
    properties: { reply: { type: "string" } },
    required: ["reply"],
  },
  name: "reply_envelope",
};
function cannedResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
async function captureBody(
  modelName: string,
  params: Record<string, unknown> = { responseSchema: RESPONSE_SCHEMA }
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        captured = JSON.parse(init.body) as Record<string, unknown>;
      }
      return cannedResponse();
    }
  );
  await generateNativeChatCompletion(
    runtime(),
    "TEXT_SMALL",
    { prompt: "hi", ...params } as never,
    { modelName, prompt: "hi" }
  );
  return captured;
}
describe("native /chat/completions response_format gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    DEFAULT_CEREBRAS_TEXT_MODEL,
    `cerebras:${DEFAULT_CEREBRAS_TEXT_MODEL}`,
    "gpt-oss-120b",
    "zai-glm-4.7",
    "gemma-4-31b",
    "gpt-4o-mini",
  ])("omits response_format for %s", async (modelName) => {
    const body = await captureBody(modelName);
    expect(body).not.toBeNull();
    expect(body?.response_format).toBeUndefined();
  });
  it.each(["raw", "schema", "jsonSchema"])(
    "sends the complete closed evaluator schema once for %s input and preserves tool history",
    async (envelope) => {
      const messages = [
        { role: "system", content: "Evaluate only the recorded work." },
        { role: "user", content: "Create one reminder; wait for approval." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "proposal-call",
              type: "function",
              function: { name: "PROPOSE_DEVICE_ACTION", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "proposal-call",
          content: "Existing proposal pending; no device effect.",
        },
      ];
      const before = structuredClone(messages);
      const responseSchema = envelope === "raw" ? evaluatorSchema : { [envelope]: evaluatorSchema };
      const body = await captureBody(DEFAULT_CEREBRAS_TEXT_MODEL, {
        messages: Object.freeze(messages),
        responseSchema,
      });
      expect(body?.response_format).toBeUndefined();
      const wire = body?.messages as typeof messages;
      const instruction = wire[0].content;
      expect(instruction.startsWith(before[0].content)).toBe(true);
      const schemaText = instruction.split("Response JSON schema:\n");
      expect(schemaText).toHaveLength(2);
      expect(JSON.parse(schemaText[1])).toEqual(evaluatorSchema);
      expect(JSON.parse(schemaText[1]).additionalProperties).toBe(false);
      expect(wire.slice(1)).toEqual(before.slice(1));
      expect(messages).toEqual(before);
    }
  );
  it("adds schema instructions before a user message without changing content parts", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Keep the complete evidence." }] },
    ];
    const before = structuredClone(messages);
    const body = await captureBody(DEFAULT_CEREBRAS_TEXT_MODEL, {
      messages,
      responseSchema: RESPONSE_SCHEMA,
    });
    const wire = body?.messages as Array<{ role: string; content: unknown }>;
    expect(wire[0].role).toBe("system");
    expect(JSON.parse(String(wire[0].content).split("Response JSON schema:\n")[1])).toEqual(
      RESPONSE_SCHEMA.schema
    );
    expect(wire.slice(1)).toEqual(before);
    expect(messages).toEqual(before);
  });
  it("does not duplicate a schema enforced by an explicit json_schema response format", async () => {
    const messages = [
      { role: "system", content: "Evaluate the result." },
      { role: "user", content: "Preserve this request." },
    ];
    const responseFormat = {
      type: "json_schema",
      json_schema: { name: "evaluator", strict: true, schema: evaluatorSchema },
    };
    const body = await captureBody(DEFAULT_CEREBRAS_TEXT_MODEL, {
      messages,
      responseSchema: { schema: evaluatorSchema, responseFormat },
    });
    expect(body?.response_format).toEqual(responseFormat);
    expect(body?.messages).toEqual(messages);
  });
  it("does not add output instructions without a caller response schema", async () => {
    const messages = [
      { role: "system", content: "Reply naturally." },
      { role: "user", content: "Hello." },
    ];
    const body = await captureBody(DEFAULT_CEREBRAS_TEXT_MODEL, { messages });
    expect(body?.messages).toEqual(messages);
    expect(body?.response_format).toBeUndefined();
  });
  it("still honors an explicit caller responseFormat override", async () => {
    const body = await captureBody("zai-glm-4.7", {
      responseSchema: {
        ...RESPONSE_SCHEMA,
        responseFormat: { type: "json_object" },
      },
    });
    expect(body?.response_format).toEqual({ type: "json_object" });
    const wire = body?.messages as Array<{ role: string; content: string }>;
    expect(JSON.parse(wire[0].content.split("Response JSON schema:\n")[1])).toEqual(
      RESPONSE_SCHEMA.schema
    );
  });
});
/**
 * The runtime asks for no hidden thinking via
 * `providerOptions.eliza.thinking="off"`; the native request must translate that
 * into each Cerebras model's supported suppression value. The knob is
 * cerebras-only, so it must not leak onto other providers.
 */
describe("native /chat/completions reasoning_effort gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    ["gpt-oss-120b", "low"],
    [DEFAULT_CEREBRAS_TEXT_MODEL, "none"],
    ["zai-glm-4.7", "none"],
  ] as const)(
    "maps eliza.thinking=off for %s to reasoning_effort:%s",
    async (modelName, expectedEffort) => {
      const body = await captureBody(modelName, {
        providerOptions: { eliza: { thinking: "off" } },
      });
      expect(body?.reasoning_effort).toBe(expectedEffort);
    }
  );
  it("preserves Gemma's omitted effort when thinking is not suppressed", async () => {
    const body = await captureBody("gemma-4-31b", {
      providerOptions: {},
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });
  it("never sets reasoning_effort for non-cerebras models", async () => {
    const body = await captureBody("gpt-4o-mini", {
      providerOptions: { eliza: { thinking: "off" } },
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });
});
