import { describe, expect, it } from "vitest";
import {
  alignDimensions,
  chunkText,
  l2Normalize,
  meanPool,
  parsePoolingStrategy,
} from "../src/index.ts";

describe("chunkText (sliding window with overlap)", () => {
  it("returns a single chunk when text fits the window", () => {
    const text = "short prompt";
    expect(chunkText(text, 1000, 64)).toEqual([text]);
  });

  it("splits long inputs into overlapping chunks", () => {
    const text = "x".repeat(20_000);
    // window 1024 tokens × 4 chars/token = 4096 chars; overlap 64 tokens = 256 chars.
    const chunks = chunkText(text, 1024, 64);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // Adjacent chunks must overlap by exactly the configured number of
    // chars (256), unless the trailing chunk is short.
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const tail = chunks[i].slice(-256);
      const head = chunks[i + 1].slice(0, 256);
      expect(head).toEqual(tail);
    }
  });

  it("handles a 16k-token document end-to-end", () => {
    // 16k tokens at ~4 chars/token = 64k chars.
    const doc = "Lorem ipsum ".repeat(64_000 / 12);
    const chunks = chunkText(doc, 1024, 64);
    expect(chunks.length).toBeGreaterThan(10);
    // Final chunk must reach the end of the doc.
    expect(chunks[chunks.length - 1]).toBe(doc.slice(doc.length - chunks[chunks.length - 1].length));
  });

  it("clamps overlap to less than the window size", () => {
    const text = "y".repeat(8_000);
    // overlap > window: should not loop forever.
    const chunks = chunkText(text, 100, 200);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("meanPool", () => {
  it("averages component-wise and yields the same dim", () => {
    const pooled = meanPool([
      [1, 2, 3, 4],
      [3, 4, 5, 6],
    ]);
    expect(pooled).toEqual([2, 3, 4, 5]);
  });

  it("rejects mismatched dimensions", () => {
    expect(() => meanPool([[1, 2, 3], [1, 2]])).toThrow(/differing dimensions/);
  });

  it("rejects empty input", () => {
    expect(() => meanPool([])).toThrow(/empty/);
  });
});

describe("l2Normalize", () => {
  it("produces a unit vector", () => {
    const vec = [3, 4];
    const norm = l2Normalize(vec);
    expect(norm).toEqual([0.6, 0.8]);
    const mag = Math.sqrt(norm[0] ** 2 + norm[1] ** 2);
    expect(mag).toBeCloseTo(1.0, 6);
  });

  it("returns the zero vector unchanged", () => {
    const vec = [0, 0, 0];
    expect(l2Normalize(vec)).toEqual([0, 0, 0]);
  });

  it("post-pool result is normalised", () => {
    // Average of two random-looking vectors, then normalise.
    const a = [0.1, 0.2, 0.3, 0.4];
    const b = [0.4, 0.3, 0.2, 0.1];
    const pooled = meanPool([a, b]);
    const normed = l2Normalize(pooled);
    let sum = 0;
    for (const v of normed) sum += v * v;
    expect(Math.sqrt(sum)).toBeCloseTo(1.0, 6);
  });
});

describe("alignDimensions", () => {
  it("returns the input untouched when dim matches", () => {
    const vec = [1, 2, 3, 4];
    expect(alignDimensions(vec, 4)).toBe(vec);
  });

  it("truncates oversized vectors", () => {
    expect(alignDimensions([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });

  it("zero-pads undersized vectors", () => {
    expect(alignDimensions([1, 2], 4)).toEqual([1, 2, 0, 0]);
  });
});

describe("parsePoolingStrategy", () => {
  it.each([
    ["mean", "mean"],
    ["MEAN", "mean"],
    ["cls", "cls"],
    ["CLS", "cls"],
    ["last", "last"],
    [undefined, "mean"],
    ["", "mean"],
    ["bogus", "mean"],
  ])("parsePoolingStrategy(%s) -> %s", (input, expected) => {
    expect(parsePoolingStrategy(input)).toBe(expected);
  });
});
