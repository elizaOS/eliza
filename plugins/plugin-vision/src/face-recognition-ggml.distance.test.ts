/**
 * Geometry tests for face-embedding distance helpers used by identity matching.
 */

import { describe, expect, it } from "vitest";
import { cosineDistance, l2Distance } from "./face-recognition-ggml.js";

const f = (...v: number[]) => new Float32Array(v);

describe("face-recognition distance metrics", () => {
  it("cosineDistance: 0 identical, 1 orthogonal, 2 opposite (unit vectors)", () => {
    expect(cosineDistance(f(1, 0), f(1, 0))).toBeCloseTo(0, 6);
    expect(cosineDistance(f(1, 0), f(0, 1))).toBeCloseTo(1, 6);
    expect(cosineDistance(f(1, 0), f(-1, 0))).toBeCloseTo(2, 6);
  });

  it("l2Distance: euclidean distance", () => {
    expect(l2Distance(f(0, 0), f(3, 4))).toBeCloseTo(5, 6);
    expect(l2Distance(f(1, 1), f(1, 1))).toBeCloseTo(0, 6);
  });

  it("both throw on embedding length mismatch", () => {
    expect(() => cosineDistance(f(1, 0), f(1, 0, 0))).toThrow(
      "length mismatch",
    );
    expect(() => l2Distance(f(1), f(1, 2))).toThrow("length mismatch");
  });
});
