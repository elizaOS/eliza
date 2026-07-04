// Exercises language model openrouter fallback behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// Native-first: a native provider serves directly; OpenRouter is the on-error
// backup. We drive the OpenAI-direct path (OPENAI_BASE_URL forces the
// chat/completions client, easy to mock by host) and assert that a retryable
// failure fails over to OpenRouter.
delete process.env.BITROUTER_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.AIGATEWAY_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_BASE_URL = "https://api.openai.test/v1";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
delete process.env.OPENROUTER_BASE_URL;

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

function hostOf(url: RequestInfo | URL): "openrouter" | "openai" | "other" {
  const u = String(url);
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("openai.test")) return "openai";
  return "other";
}

function completion(model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function badGateway(): Response {
  return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), { status: 503 });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("getLanguageModel native → OpenRouter fallback (AI SDK path)", () => {
  let hosts: Array<"openrouter" | "openai" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test("falls over to OpenRouter when the native provider returns a retryable 503", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      return host === "openrouter" ? completion("openai/gpt-4", "from-openrouter") : badGateway();
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("openai/gpt-4"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openrouter");
    expect(hosts).toEqual(["openai", "openrouter"]);
  });

  test("does not fall over on a non-retryable error (400)", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("openai/gpt-4"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // OpenRouter is never reached: a 400 is a real request error, not an outage.
    expect(hosts).toEqual(["openai"]);
  });
});
