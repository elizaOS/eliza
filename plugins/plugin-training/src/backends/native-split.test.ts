/**
 * Train/holdout split for the native backend.
 *
 * The split is deterministic via FNV-1a over each row's stable id so callers
 * can re-run optimization on the same dataset and get the same partition,
 * which is what makes the downstream promotion gate non-leaky.
 */

import { describe, expect, it } from "vitest";
import type { OptimizationExample } from "../optimizers/types.js";
import { splitTrainHoldout } from "./native.js";

function makeDataset(n: number): OptimizationExample[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ex-${i}`,
    input: { user: `row ${i}` },
    expectedOutput: `out ${i}`,
  }));
}

describe("splitTrainHoldout", () => {
  it("returns the full dataset as train when fraction is 0", () => {
    const dataset = makeDataset(20);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0);
    expect(trainSet).toBe(dataset);
    expect(holdoutSet).toEqual([]);
  });

  it("returns the full dataset as train when dataset has < 2 rows", () => {
    const dataset = makeDataset(1);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.2);
    expect(trainSet).toBe(dataset);
    expect(holdoutSet).toEqual([]);
  });

  it("approximately honors the requested fraction on larger datasets", () => {
    const dataset = makeDataset(500);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.2);
    expect(trainSet.length + holdoutSet.length).toBe(500);
    // Allow ±10% tolerance around 100 holdout rows for FNV bucketing noise.
    expect(holdoutSet.length).toBeGreaterThan(70);
    expect(holdoutSet.length).toBeLessThan(130);
  });

  it("produces identical partitions on repeated invocations", () => {
    const dataset = makeDataset(100);
    const a = splitTrainHoldout(dataset, 0.25);
    const b = splitTrainHoldout(dataset, 0.25);
    expect(a.trainSet.map((e) => e.id)).toEqual(b.trainSet.map((e) => e.id));
    expect(a.holdoutSet.map((e) => e.id)).toEqual(
      b.holdoutSet.map((e) => e.id),
    );
  });

  it("produces disjoint train + holdout subsets (no row appears in both)", () => {
    const dataset = makeDataset(200);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.2);
    const trainIds = new Set(trainSet.map((e) => e.id));
    const holdoutIds = new Set(holdoutSet.map((e) => e.id));
    for (const id of holdoutIds) {
      expect(trainIds.has(id)).toBe(false);
    }
  });

  it("falls back to position-based hashing when id is missing", () => {
    const dataset: OptimizationExample[] = Array.from(
      { length: 50 },
      (_, i) => ({ input: { user: `u${i}` }, expectedOutput: `o${i}` }),
    );
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.2);
    expect(trainSet.length + holdoutSet.length).toBe(50);
    expect(holdoutSet.length).toBeGreaterThan(0);
  });

  it("guarantees at least one holdout row when dataset has >= 5 rows", () => {
    // Engineer a small dataset where every id happens to hash above the
    // threshold — the function should still steal one row into holdout so
    // the gate has something to score against.
    const dataset = makeDataset(5);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.01);
    expect(trainSet.length + holdoutSet.length).toBe(5);
    expect(holdoutSet.length).toBeGreaterThanOrEqual(1);
  });

  it("guarantees at least one train row even when fraction is large", () => {
    const dataset = makeDataset(3);
    const { trainSet } = splitTrainHoldout(dataset, 0.5);
    expect(trainSet.length).toBeGreaterThanOrEqual(1);
  });

  it("caps the holdout fraction at 0.5 so the optimizer always has the majority", () => {
    const dataset = makeDataset(1000);
    const { trainSet, holdoutSet } = splitTrainHoldout(dataset, 0.9);
    expect(trainSet.length).toBeGreaterThanOrEqual(holdoutSet.length);
  });
});
