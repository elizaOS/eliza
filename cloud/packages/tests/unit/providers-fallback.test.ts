import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProviderForModelWithFallback } from "@/lib/providers";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "VAST_API_KEY",
  "VAST_BASE_URL_ELIZA_1_27B",
  "VAST_BASE_URL_ELIZA_1_9B",
] as const;

let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  saved = {} as typeof saved;
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

describe("getProviderForModelWithFallback", () => {
  test("groq native model returns groq primary with null fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.GROQ_API_KEY = "groq-key";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    const { primary, fallback } = getProviderForModelWithFallback("groq/compound");
    expect(primary.name).toBe("groq");
    expect(fallback).toBeNull();
  });

  test("vast native model returns a smaller Vast fallback when dedicated endpoints exist", () => {
    process.env.VAST_API_KEY = "vast-key";
    process.env.VAST_BASE_URL_ELIZA_1_27B = "https://openai.vast.ai/eliza-cloud-eliza-1-27b";
    process.env.VAST_BASE_URL_ELIZA_1_9B = "https://openai.vast.ai/eliza-cloud-eliza-1-9b";

    const { primary, fallback } = getProviderForModelWithFallback("vast/eliza-1-27b");
    expect(primary.name).toBe("vast");
    expect(fallback?.name).toBe("vast");
  });

  test("openai/* with OPENAI_API_KEY set returns openrouter + openai fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.OPENAI_API_KEY = "openai-key";
    delete process.env.ANTHROPIC_API_KEY;

    const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-5.4-mini");
    expect(primary.name).toBe("openrouter");
    expect(fallback?.name).toBe("openai");
  });

  test("openai/* without OPENAI_API_KEY returns null fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    delete process.env.OPENAI_API_KEY;

    const { primary, fallback } = getProviderForModelWithFallback("openai/gpt-5.4-mini");
    expect(primary.name).toBe("openrouter");
    expect(fallback).toBeNull();
  });

  test("anthropic/* with ANTHROPIC_API_KEY set returns openrouter + anthropic fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    delete process.env.OPENAI_API_KEY;

    const { primary, fallback } = getProviderForModelWithFallback("anthropic/claude-opus-4.7");
    expect(primary.name).toBe("openrouter");
    expect(fallback?.name).toBe("anthropic");
  });

  test("anthropic/* without ANTHROPIC_API_KEY returns null fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    delete process.env.ANTHROPIC_API_KEY;

    const { primary, fallback } = getProviderForModelWithFallback("anthropic/claude-opus-4.7");
    expect(primary.name).toBe("openrouter");
    expect(fallback).toBeNull();
  });

  test("non-matching model family (xai, google, mistral) returns null fallback", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    for (const id of ["xai/grok-4", "google/gemini-3-pro-preview", "mistral/codestral"]) {
      const { primary, fallback } = getProviderForModelWithFallback(id);
      expect(primary.name).toBe("openrouter");
      expect(fallback).toBeNull();
    }
  });
});
