// Exercises recall-bench benchmark recall bench embedding.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  cosine,
  embedText,
  RECALL_BENCH_EMBEDDING_DIM,
  tokenize,
} from "./embedding.ts";

describe("recall-bench embedding", () => {
  it("is deterministic and unit-normalized", () => {
    const a = embedText("the agent recalls relevant memories");
    const b = embedText("the agent recalls relevant memories");
    expect(a).toEqual(b);
    expect(a).toHaveLength(RECALL_BENCH_EMBEDDING_DIM);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it("returns a zero vector for empty / token-free text", () => {
    const z = embedText("   !!!  ");
    expect(z.every((x) => x === 0)).toBe(true);
  });

  it("ranks lexical overlap above unrelated text", () => {
    const q = embedText("how do I configure the database adapter");
    const related = embedText("configure the database adapter settings");
    const unrelated = embedText("bananas are a tropical yellow fruit");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });

  it("gives morphological variants a real semantic edge over an unrelated term — the signal that lets vector out-recall keyword", () => {
    const q = embedText("configuring");
    // "configuration" shares no whole token with "configuring", but shares
    // character trigrams → the subword signal keyword/substring matching lacks.
    const morph = cosine(q, embedText("configuration"));
    const unrelated = cosine(q, embedText("banana"));
    expect(morph).toBeGreaterThan(unrelated);
    expect(morph).toBeGreaterThan(0.1);
  });

  it("tokenize lowercases + splits on non-alphanumerics", () => {
    expect(tokenize("Hello, World! 007")).toEqual(["hello", "world", "007"]);
  });
});
