/**
 * Covers canonical-pair derivation through boot env seeding: qualified values
 * reach their targeted family verbatim, unqualified values pass the
 * OpenAI-id-shape guard, the Cerebras LARGE seed has its own canonical leg,
 * and pair-unset boots seed identically to before. Deterministic — env
 * save/restore per test, no runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProviderModelEnvDefaults } from "./provider-model-defaults.ts";

const KEYS = [
  "ELIZA_MODEL_SMALL",
  "ELIZA_MODEL_LARGE",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "GOOGLE_SMALL_MODEL",
  "GOOGLE_LARGE_MODEL",
  "GROQ_SMALL_MODEL",
  "GROQ_LARGE_MODEL",
  "CEREBRAS_SMALL_MODEL",
  "CEREBRAS_LARGE_MODEL",
  "CEREBRAS_MODEL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("applyProviderModelEnvDefaults canonical pair", () => {
  it("seeds identically to before when the pair is unset", () => {
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_SMALL_MODEL).toBe("gemini-3-flash-preview");
    expect(process.env.GOOGLE_LARGE_MODEL).toBe("gemini-3.1-pro-preview");
    expect(process.env.GROQ_SMALL_MODEL).toBe("openai/gpt-oss-120b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("gemma-4-31b");
  });

  it("qualified cerebras pair reaches BOTH cerebras tiers (the large leg exists)", () => {
    process.env.ELIZA_MODEL_SMALL = "cerebras/gemma-4-31b";
    process.env.ELIZA_MODEL_LARGE = "cerebras/zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
  });

  it("unqualified non-openai pair flows into cerebras/groq seeds", () => {
    process.env.ELIZA_MODEL_SMALL = "gemma-4-31b";
    process.env.ELIZA_MODEL_LARGE = "zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(process.env.GROQ_LARGE_MODEL).toBe("zai-glm-4.7");
  });

  it("unqualified openai-shaped pair NEVER poisons groq/cerebras seeds", () => {
    process.env.ELIZA_MODEL_SMALL = "gpt-5.6-luna";
    process.env.ELIZA_MODEL_LARGE = "gpt-5.6-sol";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe("openai/gpt-oss-120b");
    expect(process.env.GROQ_LARGE_MODEL).toBe("openai/gpt-oss-120b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("gemma-4-31b");
  });

  it("qualified groq pair is accepted verbatim even when openai-shaped", () => {
    process.env.ELIZA_MODEL_SMALL = "groq/openai/gpt-oss-120b";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe("openai/gpt-oss-120b");
  });

  it("qualified pair for another family never leaks into google seeds", () => {
    process.env.ELIZA_MODEL_SMALL = "anthropic/claude-sonnet-5";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_SMALL_MODEL).toBe("gemini-3-flash-preview");
  });

  it("explicit provider env still wins over the pair", () => {
    process.env.CEREBRAS_LARGE_MODEL = "explicit-glm";
    process.env.ELIZA_MODEL_LARGE = "cerebras/other-model";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("explicit-glm");
  });
});
