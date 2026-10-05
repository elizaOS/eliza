// Verifies the cross-provider fallback policy seam in the AI-SDK language-model router.
import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

delete process.env.BITROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_BASE_URL = "https://api.openai.test/v1";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
delete process.env.OPENROUTER_BASE_URL;

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

const { generateText } = await import("ai");
const { getLanguageModel, ProviderFallbackRefusedError } = await import("./language-model");
type FallbackContext = import("./language-model").ProviderFallbackContext;

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "gpt-test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function recordHosts(): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("openrouter.ai")) {
      hosts.push("openrouter");
      return completion("from-openrouter");
    }
    hosts.push("openai");
    return new Response(JSON.stringify({ error: { message: "Service Unavailable" } }), {
      status: 503,
    });
  }) as typeof fetch;
  return hosts;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("provider fallback policy", () => {
  test("default policy keeps the OpenRouter fallback and reports it", async () => {
    const hosts = recordHosts();
    const selections: Array<{ provider: string; fallback: boolean }> = [];
    const result = await generateText({
      model: getLanguageModel("openai/gpt-test", undefined, (s) => selections.push(s)),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("from-openrouter");
    expect(hosts).toEqual(["openai", "openrouter"]);
    expect(selections).toEqual([{ provider: "openrouter", fallback: true }]);
  });

  test("a refusing policy sends zero bytes to OpenRouter and throws a typed error", async () => {
    const hosts = recordHosts();
    const seen: FallbackContext[] = [];
    const call = generateText({
      model: getLanguageModel("openai/gpt-test", undefined, undefined, {
        fallbackPolicy: (context) => {
          seen.push(context);
          return { allow: false, reason: "destination_not_approved" };
        },
      }),
      prompt: "hi",
      maxRetries: 0,
    });
    const error = await call.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderFallbackRefusedError);
    expect((error as InstanceType<typeof ProviderFallbackRefusedError>).code).toBe(
      "PROVIDER_FALLBACK_REFUSED",
    );
    expect((error as Error).cause).toBeDefined();
    expect(hosts).toEqual(["openai"]);
    expect(seen).toEqual([
      {
        model: "openai/gpt-test",
        primary: "openai",
        alternate: "openrouter",
        alternateModel: "openai/gpt-test",
        operation: "generate",
        status: 503,
      },
    ]);
  });
});
