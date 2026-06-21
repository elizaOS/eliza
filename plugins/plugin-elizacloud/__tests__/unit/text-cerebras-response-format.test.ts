/**
 * Offline unit coverage for the native `/chat/completions` `response_format`
 * gate. Cerebras-served models (the gpt-oss family) 400 on
 * `response_format: { type: "json_schema" }`, so for those models the wire body
 * must carry `{ type: "json_object" }` instead. Every other model keeps the
 * full `json_schema` payload so structured output stays schema-constrained.
 *
 * The fetch is mocked: we capture the request body and return a canned
 * chat-completions response, asserting only the outgoing `response_format`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateNativeChatCompletion } from "../../src/models/text";

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;

function runtime(): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  };
  const fixture: RuntimeFixture = {
    character: { name: "Eliza", bio: [] },
    getSetting: (key: string) => settings[key],
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

async function captureResponseFormat(modelName: string): Promise<unknown> {
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
    { prompt: "hi", responseSchema: RESPONSE_SCHEMA } as never,
    { modelName, prompt: "hi" }
  );

  return (captured as Record<string, unknown> | null)?.response_format;
}

describe("native /chat/completions response_format gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits json_object for cerebras-served gpt-oss models", async () => {
    const responseFormat = await captureResponseFormat("gpt-oss-120b");
    expect(responseFormat).toEqual({ type: "json_object" });
  });

  it("keeps json_schema for non-cerebras models", async () => {
    const responseFormat = await captureResponseFormat("zai-glm-4.7");
    expect(responseFormat).toMatchObject({
      type: "json_schema",
      json_schema: { name: "reply_envelope" },
    });
  });
});
