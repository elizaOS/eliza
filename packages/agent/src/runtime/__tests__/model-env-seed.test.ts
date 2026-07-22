/**
 * Provider model-env seeding rules (`applyProviderModelEnvDefaults`).
 * `CEREBRAS_MODEL` is the fallback for every tier whose explicit
 * `OPENAI_*_MODEL` var is unset (response-handler, planner, nano, medium), so
 * it must seed from the shared SMALL model — seeding it from the large model
 * silently promoted all of those tiers to the large reasoning model (#16402:
 * Stage-1 latency spiked 1.2s→10s+ on hidden thinking bursts). Env is
 * snapshotted/restored; deterministic, no runtime boot.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProviderModelEnvDefaults,
  isLikelyOpenAiTextModel,
} from "../provider-model-defaults";

const originalEnv = { ...process.env };

const MODEL_ENV_KEYS = [
  "CEREBRAS_MODEL",
  "CEREBRAS_SMALL_MODEL",
  "CEREBRAS_LARGE_MODEL",
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
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.CEREBRAS_LARGE_MODEL).toBe("zai-glm-4.7");
  });

  it("falls back to the approved Cerebras default when the shared small model is OpenAI-only", () => {
    process.env.OPENAI_SMALL_MODEL = "gpt-5.5-mini";
    process.env.OPENAI_LARGE_MODEL = "zai-glm-4.7";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
  });

  it("keeps the compatibility alias aligned with an explicit small tier", () => {
    process.env.CEREBRAS_SMALL_MODEL = "qwen-small-explicit";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe("qwen-small-explicit");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBe("qwen-small-explicit");
  });

  it("preserves an explicit CEREBRAS_MODEL override", () => {
    process.env.CEREBRAS_MODEL = "qwen-3-235b";
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";

    applyProviderModelEnvDefaults();

    expect(process.env.CEREBRAS_MODEL).toBe("qwen-3-235b");
    expect(process.env.CEREBRAS_SMALL_MODEL).toBeUndefined();
    expect(process.env.CEREBRAS_LARGE_MODEL).toBeUndefined();
  });

  it("keeps the Groq tiers seeded from their own shared models", () => {
    process.env.SMALL_MODEL = "gemma-4-31b";
    process.env.LARGE_MODEL = "zai-glm-4.7";

    applyProviderModelEnvDefaults();

    expect(process.env.GROQ_SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.GROQ_LARGE_MODEL).toBe("zai-glm-4.7");
  });

  it("recognizes OpenAI reasoning/fine-tune families without rejecting portable GPT OSS ids", () => {
    for (const model of [
      "gpt-5.5-mini",
      "chatgpt-4o-latest",
      "codex-mini-latest",
      "o1",
      "o3-mini",
      "o4-mini",
      "ft:gpt-5-mini:org:job",
      "openai/o3",
      "openai/gpt-oss-120b:nitro",
      "openai/gpt-oss-120b:free",
      "openai/gpt-oss-120b:online",
      "gpt-oss-120b:nitro",
      "openai/vendor-specific-model",
    ]) {
      expect(isLikelyOpenAiTextModel(model), model).toBe(true);
    }
    for (const model of [
      "gpt-oss-120b",
      "openai/gpt-oss-120b",
      "gemma-4-31b",
      "zai-glm-4.7",
    ]) {
      expect(isLikelyOpenAiTextModel(model), model).toBe(false);
    }
  });

  it("is invoked once on the synchronous boot path before provider selection", () => {
    const source = readFileSync(
      new URL("../eliza.ts", import.meta.url),
      "utf8",
    );
    const calls = [
      ...source.matchAll(/applyProviderModelEnvDefaults\(\);/g),
    ].map((match) => match.index);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(
      source.indexOf("applySubscriptionCredentialsLocal(config)"),
    );
    expect(calls[0]).toBeGreaterThan(
      source.indexOf(
        "await applyVaultProfilesForAgent(sharedVault(), agentId)",
      ),
    );
    expect(calls[0]).toBeLessThan(
      source.indexOf("const configuredProviderPluginNames"),
    );
    expect(source.indexOf("const warmEmbeddingModel")).toBeGreaterThan(
      calls[0],
    );
  });
});
