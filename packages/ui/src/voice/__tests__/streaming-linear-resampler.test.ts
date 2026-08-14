/** Verifies boundary-continuous realtime PCM resampling in both directions. */

import { describe, expect, it } from "vitest";

import { StreamingLinearResampler } from "../streaming-linear-resampler";

function concatenate(blocks: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(
    blocks.reduce((length, block) => length + block.length, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

describe("StreamingLinearResampler", () => {
  it("produces the same stream across arbitrary push boundaries", () => {
    const input = Float32Array.from({ length: 997 }, (_, index) =>
      Math.sin(index / 19),
    );
    const whole = new StreamingLinearResampler(44_100, 16_000).push(input);
    const splitResampler = new StreamingLinearResampler(44_100, 16_000);
    const split = concatenate([
      splitResampler.push(input.slice(0, 17)),
      splitResampler.push(input.slice(17, 401)),
      splitResampler.push(input.slice(401, 777)),
      splitResampler.push(input.slice(777)),
    ]);

    expect(split.length).toBe(whole.length);
    for (let index = 0; index < whole.length; index += 1) {
      expect(split[index]).toBeCloseTo(whole[index], 6);
    }
  });

  it("downsamples 48kHz capture to one 20ms 16kHz frame", () => {
    const output = new StreamingLinearResampler(48_000, 16_000).push(
      new Float32Array(960).fill(0.25),
    );

    expect(output).toHaveLength(320);
    for (const sample of output) expect(sample).toBeCloseTo(0.25, 6);
  });

  it("upsamples 16kHz playout without a frame-boundary discontinuity", () => {
    const resampler = new StreamingLinearResampler(16_000, 48_000);
    const output = concatenate([
      resampler.push(Float32Array.from([0, 0.25, 0.5])),
      resampler.push(Float32Array.from([0.75, 1])),
    ]);

    expect(output.length).toBeGreaterThanOrEqual(11);
    for (let index = 1; index < output.length; index += 1) {
      expect(output[index]).toBeGreaterThanOrEqual(output[index - 1]);
      expect(output[index] - output[index - 1]).toBeLessThan(0.1);
    }
  });

  it("passes equal-rate blocks through unchanged", () => {
    const input = Float32Array.from([0.25, -0.5]);
    expect(new StreamingLinearResampler(16_000, 16_000).push(input)).toBe(
      input,
    );
  });

  it("reset discards the held interpolation sample", () => {
    const resampler = new StreamingLinearResampler(16_000, 48_000);
    expect(resampler.push(Float32Array.of(1))).toHaveLength(0);
    resampler.reset();

    const output = resampler.push(Float32Array.from([0, 0]));
    expect(output.every((sample) => sample === 0)).toBe(true);
  });

  it("rejects non-positive and non-finite sample rates", () => {
    expect(() => new StreamingLinearResampler(0, 16_000)).toThrow(RangeError);
    expect(() => new StreamingLinearResampler(16_000, Number.NaN)).toThrow(
      RangeError,
    );
  });
});
