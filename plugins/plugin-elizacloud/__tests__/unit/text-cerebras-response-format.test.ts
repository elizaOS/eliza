/**
 * Offline unit coverage for the native `/chat/completions` `response_format`
 * gate. The Cloud gateway 400s on `response_format` for its served models —
 * both `json_schema` and `json_object` (verified live against zai-glm-4.7 and
 * gemma-4-31b) — so the wire body must omit `response_format` entirely and
 * rely on the schema embedded in the prompt. Only an explicit caller-supplied
 * `responseFormat` override still reaches the wire.
 *
 * The fetch is mocked: we capture the request body and return a canned
 * chat-completions response, asserting only the outgoing `response_format`.
 */
import { DEFAULT_CEREBRAS_TEXT_MODEL, type IAgentRuntime } from "@elizaos/core";
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

  it("still honors an explicit caller responseFormat override", async () => {
    const body = await captureBody("zai-glm-4.7", {
      responseSchema: {
        ...RESPONSE_SCHEMA,
        responseFormat: { type: "json_object" },
      },
    });
    expect(body?.response_format).toEqual({ type: "json_object" });
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
  ] as const)("maps eliza.thinking=off for %s to reasoning_effort:%s", async (modelName, expectedEffort) => {
    const body = await captureBody(modelName, {
      providerOptions: { eliza: { thinking: "off" } },
    });
    expect(body?.reasoning_effort).toBe(expectedEffort);
  });

  it("omits reasoning_effort when thinking is not suppressed", async () => {
    const body = await captureBody(DEFAULT_CEREBRAS_TEXT_MODEL, {
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
