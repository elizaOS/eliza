// Exercises language model openrouter primary behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// OpenRouter-only deployment: NO BitRouter (and no other gateway/native key), so
// OpenRouter is the PRIMARY router, not a fallback. Exercises the catch-all and
// requiresBitRouterRouting->OpenRouter substitute paths in getLanguageModel.
delete process.env.BITROUTER_API_KEY;
delete process.env.BITROUTER_BASE_URL;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.AIGATEWAY_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.GROQ_API_KEY;
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
const { getLanguageModel, resolveAiProviderSource, hasLanguageModelProviderConfigured } =
  await import("./language-model");

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

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("OpenRouter-only deployment (BitRouter unset)", () => {
  test("getLanguageModel serves a catalog model directly via openrouter.ai", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = String(url);
      return completion("anthropic/claude-sonnet-4.6", "ok");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("anthropic/claude-sonnet-4.6"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(host).toContain("openrouter.ai");
  });

  test("getLanguageModel serves a :nitro routing-suffix model via openrouter.ai", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = String(url);
      return completion("openai/gpt-oss-120b:nitro", "ok");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("openai/gpt-oss-120b:nitro"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(host).toContain("openrouter.ai");
  });

  test("resolveAiProviderSource bills OpenRouter-served models to the bitrouter price catalog", () => {
    // OpenRouter shares BitRouter's catalog; its price rows are stored under
    // billingSource "bitrouter", so attribution must be "bitrouter" (NOT a new
    // "openrouter" source that has no pricing rows and is not a PricingBillingSource).
    expect(resolveAiProviderSource("anthropic/claude-sonnet-4.6")).toBe("bitrouter");
    expect(resolveAiProviderSource("openai/gpt-oss-120b:nitro")).toBe("bitrouter");
  });

  test("hasLanguageModelProviderConfigured is true when only OpenRouter is configured", () => {
    expect(hasLanguageModelProviderConfigured("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(hasLanguageModelProviderConfigured("openai/gpt-oss-120b:nitro")).toBe(true);
    expect(hasLanguageModelProviderConfigured("x-ai/grok-4")).toBe(true);
  });
});
