/** Focused source/behavior guards for canonical local embedding boot identity. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_EMBEDDING_DIMENSION } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDefaultEmbeddingDimension } from "./local-model-warmup";

const originalDimension = process.env.EMBEDDING_DIMENSION;

afterEach(() => {
  if (originalDimension === undefined) delete process.env.EMBEDDING_DIMENSION;
  else process.env.EMBEDDING_DIMENSION = originalDimension;
});

describe("canonical local embedding warmup", () => {
  it("overwrites a stale provisioning width with the canonical width", () => {
    process.env.EMBEDDING_DIMENSION = "1536";

    ensureDefaultEmbeddingDimension();

    expect(process.env.EMBEDDING_DIMENSION).toBe(
      String(CANONICAL_EMBEDDING_DIMENSION),
    );
  });

  it("never reuses an arbitrary same-width GGUF during warmup", () => {
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "local-model-warmup.ts",
      ),
      "utf8",
    );
    expect(source).not.toContain("findExistingEmbeddingModelForWarmupReuse");
    expect(source).not.toContain("isEmbeddingWarmupReuseDisabled");
    expect(source).toContain("const model = preset.model;");
    expect(source).toContain("const modelRepo = preset.modelRepo;");
  });
});
