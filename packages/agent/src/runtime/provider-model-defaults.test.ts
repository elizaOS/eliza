/**
 * Behavioral coverage for provider-model-defaults: set-if-missing env writes,
 * OpenAI-only model-id detection, and applyProviderModelEnvDefaults seeding.
 * Drives the real module — empty env, a single override, operator-vs-default
 * ties, Google key alias order, Groq/Cerebras shared-tier copy, and GPT-OSS
 * comparator edges — with no mocks of the seeders.
 */
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProviderModelEnvDefaults,
  isLikelyOpenAiTextModel,
  setEnvIfMissing,
} from "./provider-model-defaults.ts";

const ENV_KEYS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_SMALL_MODEL",
  "GOOGLE_LARGE_MODEL",
  "GROQ_SMALL_MODEL",
  "GROQ_LARGE_MODEL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "CEREBRAS_MODEL",
  "CEREBRAS_SMALL_MODEL",
  "CEREBRAS_LARGE_MODEL",
] as const;

const GROQ_DEFAULT = "openai/gpt-oss-120b";
const GOOGLE_SMALL_DEFAULT = "gemini-3-flash-preview";
const GOOGLE_LARGE_DEFAULT = "gemini-3.1-pro-preview";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("setEnvIfMissing", () => {
  it("does not write when the incoming value is missing or empty", () => {
    setEnvIfMissing("GROQ_SMALL_MODEL", undefined);
    setEnvIfMissing("GROQ_LARGE_MODEL", "");
    expect(process.env.GROQ_SMALL_MODEL).toBeUndefined();
    expect(process.env.GROQ_LARGE_MODEL).toBeUndefined();
  });

  it("sets a single missing key", () => {
    setEnvIfMissing("GROQ_SMALL_MODEL", "gemma-4-31b");
    expect(process.env.GROQ_SMALL_MODEL).toBe("gemma-4-31b");
  });

  it("keeps an existing operator value on a tie rather than replacing it", () => {
    process.env.GROQ_SMALL_MODEL = "operator-groq";
    setEnvIfMissing("GROQ_SMALL_MODEL", "seeded-groq");
    expect(process.env.GROQ_SMALL_MODEL).toBe("operator-groq");
  });

  it("treats an empty-string occupant as missing and overwrites it", () => {
    process.env.GROQ_SMALL_MODEL = "";
    setEnvIfMissing("GROQ_SMALL_MODEL", "seeded-groq");
    expect(process.env.GROQ_SMALL_MODEL).toBe("seeded-groq");
  });

  it("writes a whitespace-only value because it is truthy", () => {
    setEnvIfMissing("GROQ_SMALL_MODEL", " ");
    expect(process.env.GROQ_SMALL_MODEL).toBe(" ");
  });

  it("writes the numeric string 0, which is truthy as an env value", () => {
    setEnvIfMissing("GROQ_SMALL_MODEL", "0");
    expect(process.env.GROQ_SMALL_MODEL).toBe("0");
  });
});

describe("isLikelyOpenAiTextModel", () => {
  it("rejects missing, empty, and whitespace-only ids", () => {
    expect(isLikelyOpenAiTextModel(undefined)).toBe(false);
    expect(isLikelyOpenAiTextModel("")).toBe(false);
    expect(isLikelyOpenAiTextModel("   ")).toBe(false);
  });

  it("recognizes gpt, chatgpt, and codex families after trim and case fold", () => {
    expect(isLikelyOpenAiTextModel("  GPT-5.5-mini  ")).toBe(true);
    expect(isLikelyOpenAiTextModel("ChatGPT-4o-latest")).toBe(true);
    expect(isLikelyOpenAiTextModel("codex-mini-latest")).toBe(true);
  });

  it("matches o1, o3, and o4 at end-of-id or with a hyphen, and rejects the rest", () => {
    expect(isLikelyOpenAiTextModel("o1")).toBe(true);
    expect(isLikelyOpenAiTextModel("o3-mini")).toBe(true);
    expect(isLikelyOpenAiTextModel("o4-mini")).toBe(true);
    expect(isLikelyOpenAiTextModel("o2")).toBe(false);
    expect(isLikelyOpenAiTextModel("o5")).toBe(false);
    expect(isLikelyOpenAiTextModel("o1preview")).toBe(false);
    expect(isLikelyOpenAiTextModel("o10")).toBe(false);
  });

  it("strips an ft: fine-tune prefix before the family check", () => {
    expect(isLikelyOpenAiTextModel("ft:gpt-5-mini:org:job")).toBe(true);
    expect(isLikelyOpenAiTextModel("ft:gemma-4-31b:org:job")).toBe(false);
  });

  it("treats any openai/ namespaced id as OpenAI-only once portable GPT-OSS is excluded", () => {
    expect(isLikelyOpenAiTextModel("openai/o3")).toBe(true);
    expect(isLikelyOpenAiTextModel("openai/vendor-specific-model")).toBe(true);
    expect(isLikelyOpenAiTextModel("openai/")).toBe(true);
    expect(isLikelyOpenAiTextModel("OpenAI/GPT-4o")).toBe(true);
  });

  it("rejects bare portable GPT-OSS ids, including the safeguard form", () => {
    expect(isLikelyOpenAiTextModel("gpt-oss-120b")).toBe(false);
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-120b")).toBe(false);
    expect(isLikelyOpenAiTextModel("GPT-OSS-20B")).toBe(false);
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-safeguard-20b")).toBe(false);
    expect(isLikelyOpenAiTextModel("gpt-oss-safeguard-8b")).toBe(false);
  });

  it("keeps GPT-OSS router variants on the conservative OpenAI-only path", () => {
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-120b:nitro")).toBe(true);
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-120b:free")).toBe(true);
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-120b:online")).toBe(true);
    expect(isLikelyOpenAiTextModel("gpt-oss-120b:nitro")).toBe(true);
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-safeguard-20b:free")).toBe(
      true,
    );
  });

  it("treats malformed gpt-oss ids that miss the portable pattern as gpt- family", () => {
    expect(isLikelyOpenAiTextModel("gpt-oss-b")).toBe(true);
    expect(isLikelyOpenAiTextModel("gpt-oss-safeguard-b")).toBe(true);
  });

  it("rejects non-OpenAI vendor ids", () => {
    expect(isLikelyOpenAiTextModel("gemma-4-31b")).toBe(false);
    expect(isLikelyOpenAiTextModel("zai-glm-4.7")).toBe(false);
    expect(isLikelyOpenAiTextModel("llama-3.3-70b")).toBe(false);
  });
});

describe("applyProviderModelEnvDefaults", () => {
  it("seeds Google, Groq, and Cerebras defaults from an empty env queue", () => {
    applyProviderModelEnvDefaults();

    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(process.env.GOOGLE_SMALL_MODEL).toBe(GOOGLE_SMALL_DEFAULT);
    expect(process.env.GOOGLE_LARGE_MODEL).toBe(GOOGLE_LARGE_DEFAULT);
    expect(process.env.GROQ_SMALL_MODEL).toBe(GROQ_DEFAULT);
    expect(process.env.GROQ_LARGE_MODEL).toBe(GROQ_DEFAULT);
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(process.env.CEREBRAS_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("is idempotent: a second pass does not change seeded values", () => {
    applyProviderModelEnvDefaults();
    const first = {
      googleSmall: process.env.GOOGLE_SMALL_MODEL,
      groqSmall: process.env.GROQ_SMALL_MODEL,
      cerebras: process.env.CEREBRAS_MODEL,
    };
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_SMALL_MODEL).toBe(first.googleSmall);
    expect(process.env.GROQ_SMALL_MODEL).toBe(first.groqSmall);
    expect(process.env.CEREBRAS_MODEL).toBe(first.cerebras);
  });

  it("canonicalizes GEMINI_API_KEY onto GOOGLE_GENERATIVE_AI_API_KEY when the long form is missing", () => {
    process.env.GEMINI_API_KEY = "gemini-secret";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("gemini-secret");
  });

  it("falls through to GOOGLE_API_KEY when GEMINI_API_KEY is absent", () => {
    process.env.GOOGLE_API_KEY = "google-secret";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("google-secret");
  });

  it("prefers GEMINI_API_KEY over GOOGLE_API_KEY when both are set", () => {
    process.env.GEMINI_API_KEY = "gemini-secret";
    process.env.GOOGLE_API_KEY = "google-secret";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("gemini-secret");
  });

  it("does not clobber an operator-provided GOOGLE_GENERATIVE_AI_API_KEY", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "canonical-secret";
    process.env.GEMINI_API_KEY = "gemini-secret";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("canonical-secret");
  });

  it("does not replace operator Google model names", () => {
    process.env.GOOGLE_SMALL_MODEL = "gemini-operator-small";
    process.env.GOOGLE_LARGE_MODEL = "gemini-operator-large";
    applyProviderModelEnvDefaults();
    expect(process.env.GOOGLE_SMALL_MODEL).toBe("gemini-operator-small");
    expect(process.env.GOOGLE_LARGE_MODEL).toBe("gemini-operator-large");
  });

  it("copies a single non-OpenAI shared small model into Groq and Cerebras small tiers", () => {
    process.env.SMALL_MODEL = "gemma-4-31b";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
    expect(process.env.GROQ_LARGE_MODEL).toBe(GROQ_DEFAULT);
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("gemma-4-31b");
  });

  it("prefers OPENAI_* over SMALL_MODEL/LARGE_MODEL when both are set", () => {
    process.env.OPENAI_SMALL_MODEL = "llama-3.3-70b";
    process.env.SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";
    process.env.LARGE_MODEL = "ignored-large";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe("llama-3.3-70b");
    expect(process.env.GROQ_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("llama-3.3-70b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
  });

  it("does not fall through an empty OPENAI_SMALL_MODEL to SMALL_MODEL", () => {
    process.env.OPENAI_SMALL_MODEL = "";
    process.env.SMALL_MODEL = "gemma-4-31b";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe(GROQ_DEFAULT);
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("seeds Groq to the GPT-OSS default when the shared model is OpenAI-only", () => {
    process.env.OPENAI_SMALL_MODEL = "gpt-5.5-mini";
    process.env.OPENAI_LARGE_MODEL = "chatgpt-4o-latest";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe(GROQ_DEFAULT);
    expect(process.env.GROQ_LARGE_MODEL).toBe(GROQ_DEFAULT);
  });

  it("keeps operator Groq model names even when shared models would copy", () => {
    process.env.GROQ_SMALL_MODEL = "operator-groq-small";
    process.env.GROQ_LARGE_MODEL = "operator-groq-large";
    process.env.SMALL_MODEL = "gemma-4-31b";
    process.env.LARGE_MODEL = "zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.GROQ_SMALL_MODEL).toBe("operator-groq-small");
    expect(process.env.GROQ_LARGE_MODEL).toBe("operator-groq-large");
  });

  it("copies independent Cerebras tiers from matching non-OpenAI shared tiers", () => {
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(process.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
  });

  it("falls Cerebras large back to the Cerebras small model when the shared large is OpenAI-only", () => {
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "gpt-5.5";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
  });

  it("uses the approved Cerebras default when the shared small model is OpenAI-only", () => {
    process.env.OPENAI_SMALL_MODEL = "gpt-5.5-mini";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(process.env.CEREBRAS_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("skips Cerebras small/large seeding when the legacy CEREBRAS_MODEL alias is set", () => {
    process.env.CEREBRAS_MODEL = "qwen-3-235b";
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_MODEL).toBe("qwen-3-235b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBeUndefined();
    expect(process.env.CEREBRAS_LARGE_MODEL).toBeUndefined();
  });

  it("aligns CEREBRAS_MODEL with an explicit CEREBRAS_SMALL_MODEL when the alias is missing", () => {
    process.env.CEREBRAS_SMALL_MODEL = "qwen-small-explicit";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("qwen-small-explicit");
    expect(process.env.CEREBRAS_MODEL).toBe("qwen-small-explicit");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("does not replace an explicit CEREBRAS_LARGE_MODEL when seeding the other tiers", () => {
    process.env.CEREBRAS_LARGE_MODEL = "operator-cerebras-large";
    applyProviderModelEnvDefaults();
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("operator-cerebras-large");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(process.env.CEREBRAS_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("does not copy a portable GPT-OSS shared model away from Groq's GPT-OSS default path identity", () => {
    process.env.SMALL_MODEL = "openai/gpt-oss-120b";
    applyProviderModelEnvDefaults();
    expect(isLikelyOpenAiTextModel("openai/gpt-oss-120b")).toBe(false);
    expect(process.env.GROQ_SMALL_MODEL).toBe("openai/gpt-oss-120b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("openai/gpt-oss-120b");
  });
});
