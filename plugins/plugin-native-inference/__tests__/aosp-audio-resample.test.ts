/**
 * Exercises the real AOSP batch-ASR resampler against hostile rate metadata
 * and bounded-output invariants without loading the native FFI library.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_AOSP_RESAMPLE_OUTPUT_SAMPLES,
  resampleAospLinear,
} from "../src/aosp-audio-resample";

describe("AOSP audio resampling bounds", () => {
  it.each([0, 1, 999, 192_001, 16_000.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe source rate %s",
    (fromRate) => {
      expect(() =>
        resampleAospLinear(new Float32Array([0.25]), fromRate, 16_000),
      ).toThrow(/rejected source rate/);
    },
  );

  it.each([0, 999, 192_001, 16_000.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    "rejects unsafe target rate %s",
    (toRate) => {
      expect(() =>
        resampleAospLinear(new Float32Array([0.25]), 16_000, toRate),
      ).toThrow(/rejected target rate/);
    },
  );

  it("preserves valid no-op and downsample behavior", () => {
    const pcm = new Float32Array(48_000);
    expect(resampleAospLinear(pcm, 16_000, 16_000)).toBe(pcm);
    expect(resampleAospLinear(pcm, 48_000, 16_000)).toHaveLength(16_000);
  });

  it("rejects output above the fixed allocation budget", () => {
    const inputLength = Math.floor(MAX_AOSP_RESAMPLE_OUTPUT_SAMPLES / 16) + 1;
    expect(() =>
      resampleAospLinear(new Float32Array(inputLength), 1_000, 16_000),
    ).toThrow(/resample output .* exceeds/);
  });
});
