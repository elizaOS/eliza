/** ERLE metrics (#12256) — pure math, edge cases + far-active masking. */

import { describe, expect, it } from "vitest";
import { computeErle, computeFarActiveErle } from "./echo-metrics.js";

describe("computeErle", () => {
  it("returns dB and handles edge cases", () => {
    const near = new Float32Array([1, 1, 1, 1]);
    const halfResidual = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(computeErle(near, halfResidual)).toBeCloseTo(6.0206, 2);
    expect(
      computeErle(new Float32Array([0, 0]), new Float32Array([1, 1])),
    ).toBe(0);
    expect(
      computeErle(new Float32Array([1, 1]), new Float32Array([0, 0])),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeFarActiveErle", () => {
  it("measures only far-active blocks", () => {
    // Two 4-sample blocks: the first has far energy (echo cancelled 1 → 0.1),
    // the second is far-silent user speech that passed through untouched. The
    // whole-window ERLE would be diluted by the passthrough block; the masked
    // ERLE reads the true 20 dB of the active block.
    const near = new Float32Array([1, 1, 1, 1, 0.8, 0.8, 0.8, 0.8]);
    const residual = new Float32Array([0.1, 0.1, 0.1, 0.1, 0.8, 0.8, 0.8, 0.8]);
    const far = new Float32Array([0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
    const { erleDb, farActiveSamples } = computeFarActiveErle(
      near,
      residual,
      far,
      { blockSamples: 4 },
    );
    expect(farActiveSamples).toBe(4);
    expect(erleDb).toBeCloseTo(20, 5);
  });

  it("returns null ERLE when no block is far-active", () => {
    const silentFar = new Float32Array(8);
    const { erleDb, farActiveSamples } = computeFarActiveErle(
      new Float32Array(8).fill(0.5),
      new Float32Array(8).fill(0.5),
      silentFar,
      { blockSamples: 4 },
    );
    expect(erleDb).toBeNull();
    expect(farActiveSamples).toBe(0);
  });
});
