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

  it("emits json_object for cerebras-served gpt-oss models", async () => {
    const body = await captureBody("gpt-oss-120b");
    expect(body?.response_format).toEqual({ type: "json_object" });
  });

  it("keeps json_schema for non-cerebras models", async () => {
    const body = await captureBody("zai-glm-4.7");
    expect(body?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "reply_envelope" },
    });
  });
});

/**
 * gpt-oss runs a hidden reasoning pass before answering even when the caller
 * wants none (~4s/call vs ~0.7s suppressed). The runtime asks for none via
 * `providerOptions.eliza.thinking="off"`; the native request must translate that
 * into cerebras's `reasoning_effort:"low"`. The knob is cerebras-only — other
 * providers (e.g. zai-glm-4.7) ignore it, so it must not leak onto their wire.
 */
describe("native /chat/completions reasoning_effort gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps eliza.thinking=off to reasoning_effort:low for cerebras gpt-oss", async () => {
    const body = await captureBody("gpt-oss-120b", {
      providerOptions: { eliza: { thinking: "off" } },
    });
    expect(body?.reasoning_effort).toBe("low");
  });

  it("omits reasoning_effort when thinking is not suppressed", async () => {
    const body = await captureBody("gpt-oss-120b", { providerOptions: {} });
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("never sets reasoning_effort for non-cerebras models", async () => {
    const body = await captureBody("zai-glm-4.7", {
      providerOptions: { eliza: { thinking: "off" } },
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });
});
