import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

process.env.BITROUTER_API_KEY = "test-key";
delete process.env.BITROUTER_BASE_URL;

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
      model: getLanguageModel("openai/gpt-oss-120b:nitro"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(models).toEqual(["openai/gpt-oss-120b:nitro", "openai/gpt-oss-120b"]);
  });

  test("does not retry when the base model also fails (surfaces the error)", async () => {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      models.push(bodyModel(init));
      return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), { status: 503 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("openai/gpt-oss-120b:nitro"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    expect(models).toEqual(["openai/gpt-oss-120b:nitro", "openai/gpt-oss-120b"]);
  });
});
