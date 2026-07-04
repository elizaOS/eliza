// Exercises provider fallback selection behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, mock, test } from "bun:test";

// Raw-fetch failover selector used by v1/apps/[id]/chat. Direct-first: native
// providers serve their own models; OpenRouter (BYOK) is the on-error backup for
// native families and the direct gateway for models we have no native key for.
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.CEREBRAS_API_KEY = "test-cerebras-key";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

const { getProviderForModelWithFallback } = await import("./index");

describe("getProviderForModelWithFallback (native-first, OpenRouter backup)", () => {
  test("openai/* → OpenAI direct primary, OpenRouter backup", () => {
    const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-4");
    expect(primary.name).toBe("openai");
    expect(fallback?.name).toBe("openrouter");
  });

  test("anthropic/* → Anthropic direct primary, OpenRouter backup", () => {
    const { primary, fallback } = getProviderForModelWithFallback("anthropic/claude-sonnet-4.6");
    expect(primary.name).toBe("anthropic");
    expect(fallback?.name).toBe("openrouter");
  });

  test("Cerebras paid/default ids → Cerebras direct primary with no OpenRouter fallback", () => {
    const bare = getProviderForModelWithFallback("gpt-oss-120b");
    expect(bare.primary.name).toBe("cerebras");
    expect(bare.fallback).toBeNull();

    const decorated = getProviderForModelWithFallback("openai/gpt-oss-120b:nitro");
    expect(decorated.primary.name).toBe("cerebras");
    expect(decorated.fallback).toBeNull();
  });

  test("Cerebras free ids stay on the gateway path, not OpenAI direct", () => {
    const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-oss-120b:free");
    expect(primary.name).toBe("openrouter");
    expect(fallback).toBeNull();
  });

  test("Cerebras ids fall back to OpenRouter when the Cerebras key is absent", () => {
    const previous = process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    try {
      const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-oss-120b:nitro");
      expect(primary.name).toBe("openrouter");
      expect(fallback).toBeNull();
    } finally {
      process.env.CEREBRAS_API_KEY = previous;
    }
  });

  test("models with no native key (x-ai/*, google/*) → OpenRouter direct, no further fallback", () => {
    const grok = getProviderForModelWithFallback("x-ai/grok-4");
    expect(grok.primary.name).toBe("openrouter");
    expect(grok.fallback).toBeNull();

    const gemini = getProviderForModelWithFallback("google/gemini-2.5-pro");
    expect(gemini.primary.name).toBe("openrouter");
    expect(gemini.fallback).toBeNull();
  });
});
