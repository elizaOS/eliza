import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

process.env.BITROUTER_API_KEY = "test-key";
delete process.env.BITROUTER_BASE_URL;
process.env.CEREBRAS_API_KEY = "test-cerebras-key";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

const { generateText } = await import("ai");
const { getLanguageModel } = await import("./language-model");

function bodyModel(init: RequestInit | undefined): string {
  return (JSON.parse(String(init?.body)) as { model: string }).model;
}

function completion(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("getLanguageModel BitRouter :nitro failover (AI SDK path)", () => {
  let models: string[];

  // A NON-Cerebras :nitro id so it routes through BitRouter. Cerebras-native
  // :nitro ids (gpt-oss-120b / zai-glm-4.7) now route to cerebras-direct instead
  // — see the cerebras-direct test below — so they must not be used here.
  const NITRO = "openai/gpt-4o-mini:nitro";
  const BASE = "openai/gpt-4o-mini";

  beforeEach(() => {
    models = [];
  });

  test("falls back to the base model when :nitro returns 503", async () => {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const model = bodyModel(init);
      models.push(model);
      if (model.endsWith(":nitro")) {
        return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), { status: 503 });
      }
      return completion(model);
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel(NITRO),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(models).toEqual([NITRO, BASE]);
  });

  test("does not retry when the base model also fails (surfaces the error)", async () => {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), { status: 503 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel(NITRO),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    expect(models).toEqual([NITRO, BASE]);
  });

  test("Cerebras-native :nitro ids route to cerebras-direct, not OpenRouter", async () => {
    // Dedicated agents emit decorated ids like "openai/gpt-oss-120b:nitro" for
    // what are really bare Cerebras models. Those must hit cerebras-direct (the
    // request body carries the bare id, never the :nitro/openai/ decoration),
    // otherwise they leak to the public BitRouter → OpenRouter and 429/500.
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const model = bodyModel(init);
      models.push(model);
      return completion(model);
    }) as typeof fetch;

    await generateText({
      model: getLanguageModel("openai/gpt-oss-120b:nitro"),
      prompt: "hi",
      maxRetries: 0,
    });
    await generateText({
      model: getLanguageModel("openai/zai-glm-4.7:nitro"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(models).toEqual(["gpt-oss-120b", "zai-glm-4.7"]);
  });
});
