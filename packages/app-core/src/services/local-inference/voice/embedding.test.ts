/**
 * Local-embedding route resolution (`embedding.ts`):
 *   - `0_6b` → pooled-text source on the text backbone with `--pooling last`
 *     (no separate GGUF), and the route carries `--embeddings --pooling last`
 *   - `1_7b` / `9b` / `27b` / `27b-256k` / `27b-1m` → dedicated `embedding/`
 *     region; hard-fails when that region is missing (AGENTS.md §1 — do NOT
 *     collapse to pooled text on the larger tiers; that breaks the 1024-dim
 *     Matryoshka contract)
 *   - every route guarantees 1024 dimensions
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLocalEmbeddingRoute,
  EMBEDDING_DIR_REL_PATH,
  resolveLocalEmbeddingSource,
} from "./embedding";
import { VoiceStartupError } from "./errors";

function tmpBundle(): string {
  return mkdtempSync(path.join(tmpdir(), "eliza-emb-"));
}

describe("resolveLocalEmbeddingSource", () => {
  it("0_6b: uses the text backbone with --pooling last (no separate GGUF)", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "eliza-1-0_6b-32k.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const src = resolveLocalEmbeddingSource({
      bundleRoot,
      tierId: "eliza-1-0_6b",
      textModelPath: textPath,
    });
    expect(src.kind).toBe("pooled-text");
    if (src.kind === "pooled-text") {
      expect(src.poolingType).toBe("last");
      expect(src.textModelPath).toBe(textPath);
    }
  });

  it("1_7b: uses a dedicated embedding/ region", () => {
    const bundleRoot = tmpBundle();
    const embPath = path.join(
      bundleRoot,
      EMBEDDING_DIR_REL_PATH,
      "qwen3-embedding-0.6b.gguf",
    );
    mkdirSync(path.dirname(embPath), { recursive: true });
    writeFileSync(embPath, "gguf");
    const src = resolveLocalEmbeddingSource({
      bundleRoot,
      tierId: "eliza-1-1_7b",
      textModelPath: "/unused.gguf",
    });
    expect(src.kind).toBe("dedicated-region");
    if (src.kind === "dedicated-region") {
      expect(src.embeddingModelPath).toBe(embPath);
      expect(src.dimensions).toBe(1024);
    }
  });

  it("hard-fails when a non-0_6b tier is missing its embedding/ region", () => {
    const bundleRoot = tmpBundle();
    expect(() =>
      resolveLocalEmbeddingSource({
        bundleRoot,
        tierId: "eliza-1-9b",
        textModelPath: "/unused.gguf",
      }),
    ).toThrow(VoiceStartupError);
  });
});

describe("buildLocalEmbeddingRoute", () => {
  it("0_6b route emits --embeddings --pooling last and guarantees 1024 dims", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "t.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-0_6b",
      textModelPath: textPath,
    });
    expect(route.dimensions).toBe(1024);
    expect(route.serverFlags).toEqual(["--embeddings", "--pooling", "last"]);
  });

  it("dedicated-region route has no extra server flags", () => {
    const bundleRoot = tmpBundle();
    const embPath = path.join(bundleRoot, EMBEDDING_DIR_REL_PATH, "e.gguf");
    mkdirSync(path.dirname(embPath), { recursive: true });
    writeFileSync(embPath, "gguf");
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-27b",
      textModelPath: "/unused.gguf",
    });
    expect(route.dimensions).toBe(1024);
    expect(route.serverFlags).toEqual([]);
  });
});
