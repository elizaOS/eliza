// Exercises the canonical-pair leg of getDefaultModels with deterministic env fixtures.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
  CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
} from "../models";
import { getDefaultModels } from "./config";

/**
 * `getDefaultModels` is the cloud-lane read of the canonical two-knob pair
 * (ELIZA_MODEL_SMALL/LARGE): the pair sits below the ELIZAOS_CLOUD_* escape
 * hatches and above the Cerebras defaults, blank values are unset, and the
 * embedding model never derives from the pair (dimension pinning).
 */
const ENV_KEYS = [
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_EMBEDDING_MODEL",
  "ELIZA_MODEL_SMALL",
  "ELIZA_MODEL_LARGE",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getDefaultModels canonical pair", () => {
  it("falls back to the Cerebras defaults when nothing is set", () => {
    expect(getDefaultModels()).toEqual({
      small: CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
      large: CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
      embedding: "text-embedding-3-small",
    });
  });

  it("derives small/large from the trimmed pair when the cloud keys are unset", () => {
    process.env.ELIZA_MODEL_SMALL = " canonical-small ";
    process.env.ELIZA_MODEL_LARGE = "canonical-large";
    const models = getDefaultModels();
    expect(models.small).toBe("canonical-small");
    expect(models.large).toBe("canonical-large");
  });

  it("keeps ELIZAOS_CLOUD_* as the winning escape hatch", () => {
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "explicit-small";
    process.env.ELIZA_MODEL_SMALL = "canonical-small";
    expect(getDefaultModels().small).toBe("explicit-small");
  });

  it("treats a blank pair value as unset", () => {
    process.env.ELIZA_MODEL_LARGE = "   ";
    expect(getDefaultModels().large).toBe(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL);
  });

  it("never derives the embedding model from the pair", () => {
    process.env.ELIZA_MODEL_SMALL = "canonical-small";
    expect(getDefaultModels().embedding).toBe("text-embedding-3-small");
  });
});
