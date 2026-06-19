import { describe, expect, mock, test } from "bun:test";

// Raw-fetch failover selector used by v1/apps/[id]/chat. BitRouter is primary;
// per-family direct providers win for openai/* and anthropic/* (they call the
// upstream with our own key), and OpenRouter (BYOK) is the universal fallback
// for everything else.
process.env.BITROUTER_API_KEY = "test-bitrouter-key";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

const { getProviderForModelWithFallback } = await import("./index");

describe("getProviderForModelWithFallback OpenRouter wiring", () => {
  test("openai/* falls back to OpenAI direct (NOT OpenRouter) when OPENAI_API_KEY is set", () => {
    const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-4");
    expect(primary.name).toBe("bitrouter");
    expect(fallback?.name).toBe("openai");
  });

  test("anthropic/* falls back to Anthropic direct (NOT OpenRouter) when ANTHROPIC_API_KEY is set", () => {
    const { fallback } = getProviderForModelWithFallback("anthropic/claude-sonnet-4.6");
    expect(fallback?.name).toBe("anthropic");
  });

  test("non-direct models (x-ai/*, google/*, mistralai/*) fall back to OpenRouter", () => {
    expect(getProviderForModelWithFallback("x-ai/grok-4").fallback?.name).toBe("openrouter");
    expect(getProviderForModelWithFallback("google/gemini-2.5-pro").fallback?.name).toBe(
      "openrouter",
    );
  });
});
