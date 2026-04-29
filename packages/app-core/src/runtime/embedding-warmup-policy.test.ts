import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldWarmupLocalEmbeddingModel } from "./embedding-warmup-policy";

const ENV_KEYS = [
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "MILADY_DISABLE_LOCAL_EMBEDDINGS",
  "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  "MILADY_CLOUD_EMBEDDINGS_DISABLED",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
] as const;

describe("shouldWarmupLocalEmbeddingModel", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("warms up by default (no envs set)", () => {
    expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
  });

  it("skips warmup when ELIZAOS_CLOUD_USE_EMBEDDINGS=true and no overrides", () => {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
    expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
  });

  describe("ELIZA_DISABLE_LOCAL_EMBEDDINGS short-circuits warmup", () => {
    for (const value of ["1", "true", "yes", "TRUE", "Yes"]) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = value;
        expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
      });
    }
  });

  describe("MILADY_DISABLE_LOCAL_EMBEDDINGS mirrors ELIZA_DISABLE_LOCAL_EMBEDDINGS", () => {
    for (const value of ["1", "true", "yes"]) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        process.env.MILADY_DISABLE_LOCAL_EMBEDDINGS = value;
        expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
      });
    }
  });

  describe("ELIZA_CLOUD_EMBEDDINGS_DISABLED forces local warmup", () => {
    for (const value of ["1", "true", "yes"]) {
      it(`accepts ${JSON.stringify(value)} (overrides ELIZAOS_CLOUD_USE_EMBEDDINGS=true)`, () => {
        process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
        process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = value;
        expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
      });
    }
  });

  describe("MILADY_CLOUD_EMBEDDINGS_DISABLED mirrors ELIZA_CLOUD_EMBEDDINGS_DISABLED", () => {
    for (const value of ["1", "true", "yes"]) {
      it(`accepts ${JSON.stringify(value)} (overrides ELIZAOS_CLOUD_USE_EMBEDDINGS=true)`, () => {
        process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
        process.env.MILADY_CLOUD_EMBEDDINGS_DISABLED = value;
        expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
      });
    }
  });

  it("treats unrecognized values as falsy", () => {
    process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "0";
    process.env.MILADY_DISABLE_LOCAL_EMBEDDINGS = "false";
    expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
  });

  it("ignores surrounding whitespace and case", () => {
    process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "  TRUE  ";
    expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
  });
});
