import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// BitRouter is the primary; OpenRouter is its BYOK fallback. Default base URLs
// (api.bitrouter.ai vs openrouter.ai) let the fetch mock tell them apart.
process.env.BITROUTER_API_KEY = "test-bitrouter-key";
delete process.env.BITROUTER_BASE_URL;
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

function hostOf(url: RequestInfo | URL): "openrouter" | "bitrouter" {
  return String(url).includes("openrouter.ai") ? "openrouter" : "bitrouter";
}

function completion(model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
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

describe("getLanguageModel OpenRouter fallback (AI SDK path)", () => {
  let hosts: Array<"openrouter" | "bitrouter">;

  beforeEach(() => {
    hosts = [];
  });

  test("falls over to OpenRouter when the primary returns a retryable 503", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const host = hostOf(url);
      hosts.push(host);
      return host === "openrouter"
        ? completion("anthropic/claude-sonnet-4.6", "from-openrouter")
        : badGateway();
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("anthropic/claude-sonnet-4.6"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-openrouter");
    expect(hosts).toEqual(["bitrouter", "openrouter"]);
  });

  test("does not fall over on a non-retryable error (400)", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("anthropic/claude-sonnet-4.6"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // OpenRouter is never reached: a 400 is a real request error, not an outage.
    expect(hosts).toEqual(["bitrouter"]);
  });
});
