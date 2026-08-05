// Exercises the model-routing + provider-configuration surface of language-model.ts
// that the COLDPATH-FIX interactive-failover path depends on (COLDPATH-FIX-2026-07-21).
//
// getInteractiveCerebrasLanguageModel delegates non-Cerebras ids straight to
// getLanguageModel, and the cold-path fix reasons about "which provider serves
// this model" via resolveAiProviderSource / hasLanguageModelProviderConfigured /
// the passthrough + pooled resolvers. These are pure, deterministic routers, so
// this suite pins their branch behavior directly: it is real coverage of the
// exact routing the fix rides on, not a coverage-number filler.
//
// A single deployment shape (all native keys present) lets us assert the
// precedence order deterministically; the no-key branches are covered by the
// sibling openrouter-primary / cerebras-fallback suites already.
import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

delete process.env.BITROUTER_API_KEY;
delete process.env.BITROUTER_BASE_URL;
delete process.env.OPENROUTER_BASE_URL;
process.env.CEREBRAS_API_KEY = "test-cerebras-key";
process.env.OPENAI_API_KEY = "test-openai-key";
delete process.env.OPENAI_BASE_URL;
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

const { generateText, embed } = await import("ai");

const {
  getLanguageModel,
  getTextEmbeddingModel,
  getInteractiveCerebrasLanguageModel,
  resolveAiProviderSource,
  resolveEmbeddingProviderSource,
  resolvePooledDirectProviderForModel,
  resolvePassthroughUpstreamForModel,
  resolvePassthroughEmbeddingsUpstream,
  canonicalizeCerebrasModelId,
  hasLanguageModelProviderConfigured,
  hasTextEmbeddingProviderConfigured,
  hasGatewayProviderConfigured,
  hasOpenAIProviderConfigured,
  hasAnthropicProviderConfigured,
  hasGroqLanguageModelProviderConfigured,
  hasAnyAiProviderConfigured,
  getAiProviderConfigurationStatus,
  getAiProviderConfigurationSummary,
  getAiProviderConfigurationError,
  isProviderConfigurationError,
  ProviderConfigurationError,
} = await import("./language-model");

function hostOf(url: RequestInfo | URL): string {
  const u = String(url);
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("cerebras.ai")) return "cerebras";
  if (u.includes("openai.com")) return "openai";
  if (u.includes("anthropic.com")) return "anthropic";
  if (u.includes("groq.com")) return "groq";
  return "other";
}

// OpenAI's Responses API shape (getOpenAIClient().languageModel() uses /v1/responses,
// not /v1/chat/completions, when no OPENAI_BASE_URL override is set).
function openaiResponsesCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "gpt-4o-mini",
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: content, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
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

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("resolveAiProviderSource routing precedence", () => {
  test("groq-native → groq", () => {
    expect(resolveAiProviderSource("groq/compound")).toBe("groq");
  });
  test("cerebras-native (bare) → cerebras", () => {
    expect(resolveAiProviderSource("gpt-oss-120b")).toBe("cerebras");
  });
  test("decorated cerebras id (:nitro) still → cerebras", () => {
    expect(resolveAiProviderSource("openai/gpt-oss-120b:nitro")).toBe("cerebras");
  });
  test("openai-native → openai", () => {
    expect(resolveAiProviderSource("gpt-4o-mini")).toBe("openai");
  });
  test("anthropic-native → anthropic", () => {
    expect(resolveAiProviderSource("claude-sonnet-4.6")).toBe("anthropic");
  });
});

describe("resolvePooledDirectProviderForModel", () => {
  test("cerebras-native → cerebras-api", () => {
    expect(resolvePooledDirectProviderForModel("zai-glm-4.7")).toBe("cerebras-api");
  });
  test("openai-native (non-gateway) → openai-api", () => {
    expect(resolvePooledDirectProviderForModel("gpt-4o-mini")).toBe("openai-api");
  });
  test("anthropic-native → anthropic-api", () => {
    expect(resolvePooledDirectProviderForModel("claude-sonnet-4.6")).toBe("anthropic-api");
  });
  test("a plain gateway-only id → null (no direct pool)", () => {
    expect(resolvePooledDirectProviderForModel("meta-llama/llama-3.1-8b-instruct")).toBeNull();
  });
});

describe("passthrough upstream resolvers", () => {
  test("cerebras-native resolves a direct chat-completions upstream", () => {
    const up = resolvePassthroughUpstreamForModel("openai/gpt-oss-120b:nitro");
    expect(up).not.toBeNull();
    expect(up?.providerId).toBe("cerebras-api");
    expect(up?.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(up?.modelId).toBe("gpt-oss-120b");
    expect(up?.apiKey).toBe("test-cerebras-key");
  });
  test("non-cerebras id → null passthrough", () => {
    expect(resolvePassthroughUpstreamForModel("claude-sonnet-4.6")).toBeNull();
  });
  test("embeddings passthrough resolves the openai embeddings endpoint", () => {
    const up = resolvePassthroughEmbeddingsUpstream("text-embedding-3-small");
    expect(up).not.toBeNull();
    expect(up?.providerId).toBe("openai-api");
    expect(up?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(up?.modelId).toBe("text-embedding-3-small");
  });
});

describe("canonicalizeCerebrasModelId", () => {
  test("collapses a decorated cerebras id to the bare model", () => {
    expect(canonicalizeCerebrasModelId("openai/gpt-oss-120b:nitro")).toBe("gpt-oss-120b");
  });
  test("leaves a non-cerebras id unchanged", () => {
    expect(canonicalizeCerebrasModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });
});

describe("provider-configuration predicates (all native keys present)", () => {
  test("hasLanguageModelProviderConfigured is true across provider families", () => {
    expect(hasLanguageModelProviderConfigured("gpt-oss-120b")).toBe(true);
    expect(hasLanguageModelProviderConfigured("gpt-4o-mini")).toBe(true);
    expect(hasLanguageModelProviderConfigured("claude-sonnet-4.6")).toBe(true);
    expect(hasLanguageModelProviderConfigured("groq/compound")).toBe(true);
    expect(hasLanguageModelProviderConfigured("openai/gpt-oss-120b:nitro")).toBe(true);
  });
  test("has*ProviderConfigured booleans reflect the configured keys", () => {
    expect(hasGatewayProviderConfigured()).toBe(true);
    expect(hasOpenAIProviderConfigured()).toBe(true);
    expect(hasAnthropicProviderConfigured()).toBe(true);
    expect(hasGroqLanguageModelProviderConfigured()).toBe(true);
    expect(hasTextEmbeddingProviderConfigured()).toBe(true);
    expect(hasAnyAiProviderConfigured()).toBe(true);
  });
  test("configuration status + summary enumerate the configured providers", () => {
    const status = getAiProviderConfigurationStatus();
    expect(status.cerebras).toBe(true);
    expect(status.openai).toBe(true);
    expect(status.anthropic).toBe(true);
    expect(status.groq).toBe(true);
    expect(status.openrouter).toBe(true);
    const summary = getAiProviderConfigurationSummary();
    expect(summary).toContain("cerebras");
    expect(summary).toContain("openai");
    expect(typeof getAiProviderConfigurationError()).toBe("string");
  });
  test("resolveEmbeddingProviderSource prefers openai when its key is present", () => {
    expect(resolveEmbeddingProviderSource()).toBe("openai");
  });
});

describe("isProviderConfigurationError classification", () => {
  test("true for our own ProviderConfigurationError", () => {
    expect(isProviderConfigurationError(new ProviderConfigurationError("no key"))).toBe(true);
  });
  test("false for an ordinary error", () => {
    expect(isProviderConfigurationError(new Error("boom"))).toBe(false);
  });
  test("false for a non-error value", () => {
    expect(isProviderConfigurationError("nope")).toBe(false);
  });
});

describe("getLanguageModel end-to-end routing (with a live fetch stub)", () => {
  test("cerebras-native id is served by cerebras-direct", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = hostOf(url);
      return completion("gpt-oss-120b", "ok");
    }) as typeof fetch;
    const result = await generateText({
      model: getLanguageModel("gpt-oss-120b"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(host).toBe("cerebras");
  });

  test("openai-native id is served by openai-direct", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = hostOf(url);
      return openaiResponsesCompletion("ok");
    }) as typeof fetch;
    const result = await generateText({
      model: getLanguageModel("gpt-4o-mini"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(host).toBe("openai");
  });

  test("anthropic-native id is served by anthropic-direct", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = hostOf(url);
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await generateText({
      model: getLanguageModel("claude-sonnet-4.6"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(host).toBe("anthropic");
  });

  test("getInteractiveCerebrasLanguageModel delegates a non-cerebras id to the normal router", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = hostOf(url);
      return openaiResponsesCompletion("ok");
    }) as typeof fetch;
    const result = await generateText({
      model: getInteractiveCerebrasLanguageModel("gpt-4o-mini"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(host).toBe("openai");
  });

  test("getTextEmbeddingModel is served by openai-direct", async () => {
    let host = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      host = hostOf(url);
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await embed({
      model: getTextEmbeddingModel("text-embedding-3-small"),
      value: "hi",
    });
    expect(result.embedding.length).toBe(3);
    expect(host).toBe("openai");
  });
});

void embed;
