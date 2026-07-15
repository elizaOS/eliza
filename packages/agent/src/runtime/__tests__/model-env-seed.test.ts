/**
 * Provider model-env seeding rules (`applyProviderModelEnvDefaults`).
 * `CEREBRAS_MODEL` is the fallback for every tier whose explicit
 * `OPENAI_*_MODEL` var is unset (response-handler, planner, nano, medium), so
 * it must seed from the shared SMALL model — seeding it from the large model
 * silently promoted all of those tiers to the large reasoning model (#16402:
 * Stage-1 latency spiked 1.2s→10s+ on hidden thinking bursts). Env is
 * snapshotted/restored; deterministic, no runtime boot.
 */

import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProviderModelEnvDefaults } from "../provider-model-defaults";

const originalEnv = { ...process.env };

const MODEL_ENV_KEYS = [
  "CEREBRAS_MODEL",
  "GROQ_SMALL_MODEL",
  "GROQ_LARGE_MODEL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
];

beforeEach(() => {
  for (const key of MODEL_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("provider model-env seeding", () => {
  it("seeds CEREBRAS_MODEL from the shared SMALL model, never the large model", () => {
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
  });

  it("falls back to the approved Cerebras default when the shared small model is OpenAI-only", () => {
    process.env.OPENAI_SMALL_MODEL = "gpt-5.5-mini";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("preserves an explicit CEREBRAS_MODEL override", () => {
    process.env.CEREBRAS_MODEL = "qwen-3-235b";
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe("qwen-3-235b");
  });

  it("keeps the Groq tiers seeded from their own shared models", () => {
    process.env.SMALL_MODEL = "gemma-4-31b";
    process.env.LARGE_MODEL = "zai-glm-4.7";

    applyProviderModelEnvDefaults();

    expect(process.env.GROQ_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.GROQ_LARGE_MODEL).toBe("zai-glm-4.7");
  });
});
