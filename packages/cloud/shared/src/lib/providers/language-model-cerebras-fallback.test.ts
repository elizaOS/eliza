import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// Cerebras-native bare ids serve directly via
// the Cerebras key — cerebras-only by design. There is NO OpenRouter fallback:
// a free-tier 429 must surface so the chat path can return the graceful
// "model provider rate-limited" reply rather than failing over to a different
// provider. OPENROUTER_API_KEY is set on purpose to prove the cerebras branch
// never routes to OpenRouter even when an OpenRouter key is available.
delete process.env.BITROUTER_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.AIGATEWAY_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.CEREBRAS_API_KEY = "test-cerebras-key";
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
const { getLanguageModel, resolveAiProviderSource } = await import("./language-model");

function hostOf(url: RequestInfo | URL): "openrouter" | "cerebras" | "other" {
  const u = String(url);
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("cerebras.ai")) return "cerebras";
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

function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
    status: 429,
  });
}

function authorizationHeader(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("authorization");
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? null;
  }
  return headers.authorization ?? headers.Authorization ?? null;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("getLanguageModel cerebras-direct (cerebras-only, no OpenRouter fallback)", () => {
  let hosts: Array<"openrouter" | "cerebras" | "other">;

  beforeEach(() => {
    hosts = [];
  });

  test("a bare Cerebras id serves directly via cerebras.ai on the happy path", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return completion("gemma-4-31b", "from-cerebras");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("gemma-4-31b"),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-cerebras");
    expect(hosts).toEqual(["cerebras"]);
  });

  test("a pooled Cerebras credential is used instead of the platform env key", async () => {
    const authHeaders: Array<string | null> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      hosts.push(hostOf(url));
      authHeaders.push(authorizationHeader(init));
      return completion("gemma-4-31b", "from-pooled-cerebras");
    }) as typeof fetch;

    const result = await generateText({
      model: getLanguageModel("gemma-4-31b", {
        providerId: "cerebras-api",
        apiKey: "pooled-cerebras-key",
      }),
      prompt: "hi",
      maxRetries: 0,
    });

    expect(result.text).toBe("from-pooled-cerebras");
    expect(hosts).toEqual(["cerebras"]);
    expect(authHeaders).toEqual(["Bearer pooled-cerebras-key"]);
  });

  test("a 429 surfaces (cerebras-only) and is never routed to OpenRouter", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return tooManyRequests();
    }) as typeof fetch;

    await expect(
      generateText({
        // The decorated id dedicated agents emit; still a Cerebras-native model.
        model: getLanguageModel("openai/gpt-oss-120b:nitro"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // No OpenRouter fallback: the 429 surfaces so the chat path can return the
    // graceful "model provider rate-limited" reply.
    expect(hosts).toEqual(["cerebras"]);
  });

  test("a 429 FAILS FAST under default retries (one cerebras call, no ~50s backoff loop)", async () => {
    // The bug: the gateway calls generateText/streamText WITHOUT maxRetries, so
    // the AI SDK's default (2 retries → 3 attempts) ran a 429 through ~50s of
    // exponential backoff before the graceful rate-limit reply surfaced.
    // withRateLimitFailFast re-throws the 429 as non-retryable → the SDK gives up
    // after ONE attempt. This test uses the DEFAULT retry config on purpose (no
    // maxRetries:0) — without the fix, `attempts` would be 3.
    let attempts = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      attempts++;
      return tooManyRequests();
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("openai/gpt-oss-120b:nitro"),
        prompt: "hi",
      }),
    ).rejects.toBeDefined();

    expect(attempts).toBe(1);
    expect(hosts).toEqual(["cerebras"]);
  });

  test("a non-retryable error (400) also surfaces via cerebras only", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hosts.push(hostOf(url));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      generateText({
        model: getLanguageModel("gemma-4-31b"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
    // A 400 is a real request error: OpenRouter is never reached.
    expect(hosts).toEqual(["cerebras"]);
  });

  test("happy-path billing attributes to cerebras", () => {
    expect(resolveAiProviderSource("gemma-4-31b")).toBe("cerebras");
    expect(resolveAiProviderSource("gpt-oss-120b")).toBe("cerebras");
    expect(resolveAiProviderSource("zai-glm-4.7")).toBe("cerebras");
    expect(resolveAiProviderSource("openai/gpt-oss-120b:nitro")).toBe("cerebras");
  });
});
