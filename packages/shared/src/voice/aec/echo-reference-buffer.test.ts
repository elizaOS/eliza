/**
 * Unit coverage for EchoReferenceBuffer alignment delay line in echo-reference-buffer.ts.
 *
 * Tests sample buffering, delay alignment retrieval, timestamp-aware push/read,
 * ring buffer capacity eviction, gap zero-filling, and state reset.
 */

import { describe, expect, it } from "vitest";
import { EchoReferenceBuffer } from "./echo-reference-buffer.js";

describe("EchoReferenceBuffer", () => {
  it("buffers sequential audio and reads delay-aligned reference frames", () => {
    const buffer = new EchoReferenceBuffer({ capacitySamples: 1000 });
    const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    buffer.push(samples);
    expect(buffer.position).toBe(10);

    // Read 4 samples with 2-sample delay
    // Pushed = 10, delay = 2, length = 4 -> window [10 - 2 - 4, 10 - 2) = [4, 8) -> elements at index 4,5,6,7: [5,6,7,8]
    const ref = buffer.referenceFor(4, 2);
    expect(Array.from(ref)).toEqual([5, 6, 7, 8]);
  });

  it("zero-fills regions before the earliest pushed sample", () => {
    const buffer = new EchoReferenceBuffer({ capacitySamples: 1000 });
    const samples = new Float32Array([1, 2, 3, 4]);

    buffer.push(samples);
    // Pushed = 4, delay = 4, length = 4 -> window [4 - 4 - 4, 4 - 4) = [-4, 0) -> all zeros
    const ref = buffer.referenceFor(4, 4);
    expect(Array.from(ref)).toEqual([0, 0, 0, 0]);

    // Partial overlap: window [-2, 2) -> two zeros, then samples[0], samples[1]
    const partial = buffer.referenceFor(4, 2);
    expect(Array.from(partial)).toEqual([0, 0, 1, 2]);
  });

  it("handles ring buffer capacity eviction correctly", () => {
    const buffer = new EchoReferenceBuffer({ capacitySamples: 5 });
    buffer.push(new Float32Array([1, 2, 3, 4, 5]));
    buffer.push(new Float32Array([6, 7, 8])); // pushes 3 more, total pushed = 8, capacity = 5 -> oldest retained is 8 - 5 = 3

    expect(buffer.position).toBe(8);

    // Samples 1, 2, 3 were evicted; samples 4, 5, 6, 7, 8 retained
    // Window [0, 8)
    const ref = buffer.referenceFor(8, 0);
    expect(Array.from(ref)).toEqual([0, 0, 0, 4, 5, 6, 7, 8]);
  });

  it("supports timestamp-based pushAt and referenceAt alignment", () => {
    const buffer = new EchoReferenceBuffer({
      capacitySamples: 16000,
      sampleRateHz: 1000, // 1 sample per ms for simple arithmetic
    });

    const chunk1 = new Float32Array([10, 20, 30]);
    buffer.pushAt(1000, chunk1);

    // Gap between 1000+3 = 1003ms and 1005ms
    const chunk2 = new Float32Array([40, 50]);
    buffer.pushAt(1005, chunk2);

    // Read window starting at 1000ms, length 7, delay 0
    const read = buffer.referenceAt(1000, 7, 0);
    // Expected: [10, 20, 30, 0, 0, 40, 50]
    expect(Array.from(read)).toEqual([10, 20, 30, 0, 0, 40, 50]);
  });

  it("falls back to sequential push for non-finite timestamp in pushAt", () => {
    const buffer = new EchoReferenceBuffer({ capacitySamples: 100 });
    buffer.pushAt(Number.NaN, new Float32Array([1, 2, 3]));
    expect(buffer.position).toBe(3);
  });

  it("resets all internal state and clears buffer on reset()", () => {
    const buffer = new EchoReferenceBuffer({ capacitySamples: 100 });
    buffer.push(new Float32Array([1, 2, 3, 4, 5]));
    expect(buffer.position).toBe(5);

    buffer.reset();
    expect(buffer.position).toBe(0);

    const ref = buffer.referenceFor(5, 0);
    expect(Array.from(ref)).toEqual([0, 0, 0, 0, 0]);
  });
});
