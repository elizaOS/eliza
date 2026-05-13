/**
 * Local-embedding route resolution + Matryoshka truncation (`embedding.ts`):
 *   - `0_8b` / `2b` → pooled-text source on the text backbone with `--pooling last`
 *     (no separate GGUF)
 *   - `4b` / `9b` / `27b` / `27b-256k` / `27b-1m` → dedicated `embedding/`
 *     region; hard-fails when that region is missing (AGENTS.md §1 — do NOT
 *     collapse to pooled text on the larger tiers; that breaks the 1024-dim
 *     Matryoshka contract)
 *   - every route guarantees 1024 dimensions and a sidecar embedding server
 *     launched with `--embeddings --pooling last`
 *   - `truncateMatryoshka` truncates 1024 → {64,128,256,512,768} and
 *     L2-renormalizes; rejects invalid widths
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLocalEmbeddingRoute,
  EMBEDDING_MATRYOSHKA_DIMS,
  isValidEmbeddingDim,
  resolveLocalEmbeddingSource,
  truncateMatryoshka,
} from "./embedding";

function tmpBundle(): string {
  return mkdtempSync(path.join(tmpdir(), "eliza-emb-"));
}

describe("resolveLocalEmbeddingSource", () => {
  it("0_8b: uses the text backbone with --pooling last (no separate GGUF)", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "eliza-1-0_8b-32k.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const src = resolveLocalEmbeddingSource({
      bundleRoot,
      tierId: "eliza-1-0_8b",
      textModelPath: textPath,
    });
    expect(src.kind).toBe("pooled-text");
    if (src.kind === "pooled-text") {
      expect(src.poolingType).toBe("last");
      expect(src.textModelPath).toBe(textPath);
    }
  });

  it("2b: reuses the text backbone with --pooling last (no duplicate GGUF)", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "eliza-1-2b-32k.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const src = resolveLocalEmbeddingSource({
      bundleRoot,
      tierId: "eliza-1-2b",
      textModelPath: textPath,
    });
    expect(src.kind).toBe("pooled-text");
    if (src.kind === "pooled-text") {
      expect(src.textModelPath).toBe(textPath);
      expect(src.poolingType).toBe("last");
    }
  });
});

describe("buildLocalEmbeddingRoute", () => {
  it("0_8b route emits --embeddings --pooling last and guarantees 1024 dims", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "t.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-0_8b",
      textModelPath: textPath,
    });
    expect(route.dimensions).toBe(1024);
    expect(route.defaultDim).toBe(1024);
    expect(route.matryoshkaDims).toEqual(EMBEDDING_MATRYOSHKA_DIMS);
    expect(route.serverFlags).toEqual(["--embeddings", "--pooling", "last"]);
  });
  it("accepts a smaller defaultDim and rejects invalid widths", () => {
    const bundleRoot = tmpBundle();
    const textPath = path.join(bundleRoot, "text", "t.gguf");
    mkdirSync(path.dirname(textPath), { recursive: true });
    writeFileSync(textPath, "gguf");
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-0_8b",
      textModelPath: textPath,
      defaultDim: 256,
    });
    expect(route.defaultDim).toBe(256);
    expect(() =>
      buildLocalEmbeddingRoute({
        bundleRoot,
        tierId: "eliza-1-0_8b",
        textModelPath: textPath,
        defaultDim: 300,
      }),
    ).toThrow();
  });
});

describe("truncateMatryoshka", () => {
  it("EMBEDDING_MATRYOSHKA_DIMS = {64,128,256,512,768,1024}", () => {
    expect([...EMBEDDING_MATRYOSHKA_DIMS]).toEqual([
      64, 128, 256, 512, 768, 1024,
    ]);
    expect(isValidEmbeddingDim(256)).toBe(true);
    expect(isValidEmbeddingDim(1000)).toBe(false);
  });

  it("truncates to the leading slice and L2-renormalizes", () => {
    // A 1024-dim vector that is unit-norm overall but whose leading 512
    // components are not unit-norm on their own.
    const full = new Array(1024).fill(0);
    for (let i = 0; i < 1024; i += 1) full[i] = 1 / Math.sqrt(1024);
    const half = truncateMatryoshka(full, 512);
    expect(half).toHaveLength(512);
    const norm = Math.sqrt(half.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    // Leading components preserved (up to the renormalization scale).
    expect(half[0]).toBeCloseTo(1 / Math.sqrt(512), 6);
  });

  it("renormalizes even when dim == vec.length (raw last-token state may not be unit-norm)", () => {
    const v = [3, 4]; // norm 5, not a valid Matryoshka width, but exercise the equal-length path via 64
    const v64 = new Array(64)
      .fill(0)
      .map((_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
    const out = truncateMatryoshka(v64, 64);
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    void v;
  });

  it("rejects an invalid width or a too-short vector", () => {
    expect(() => truncateMatryoshka(new Array(1024).fill(0.1), 300)).toThrow();
    expect(() => truncateMatryoshka(new Array(128).fill(0.1), 256)).toThrow();
  });

  it("passes a zero vector through unchanged", () => {
    const z = truncateMatryoshka(new Array(1024).fill(0), 64);
    expect(z.every((x) => x === 0)).toBe(true);
  });
});
