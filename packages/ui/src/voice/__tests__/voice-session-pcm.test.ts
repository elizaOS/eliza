import { describe, expect, it } from "vitest";

import {
  clampFloatSample,
  downmixChannelsToMono,
  floatPcmToInt16Bytes,
  floatSampleToInt16,
  int16BytesToFloatPcm,
  int16SampleToFloat,
} from "../voice-session-pcm";

describe("voice-session-pcm Float32↔Int16 correctness (golden vectors)", () => {
  it("maps the canonical boundary samples exactly", () => {
    // Asymmetric scale: -1 → -32768, +1 → +32767, 0 → 0.
    expect(floatSampleToInt16(0)).toBe(0);
    expect(floatSampleToInt16(1)).toBe(32767);
    expect(floatSampleToInt16(-1)).toBe(-32768);
    expect(floatSampleToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff)); // 16384 (rounded)
    expect(floatSampleToInt16(-0.5)).toBe(Math.round(-0.5 * 0x8000)); // -16384
  });

  it("clamps out-of-range and non-finite inputs without wrapping", () => {
    expect(floatSampleToInt16(2)).toBe(32767);
    expect(floatSampleToInt16(-2)).toBe(-32768);
    expect(floatSampleToInt16(Number.NaN)).toBe(0);
    expect(floatSampleToInt16(Number.POSITIVE_INFINITY)).toBe(32767);
    expect(floatSampleToInt16(Number.NEGATIVE_INFINITY)).toBe(-32768);
    // The 0.99999 * 0x7fff overshoot must not round to 32768.
    expect(floatSampleToInt16(0.999999)).toBeLessThanOrEqual(32767);
  });

  it("clampFloatSample bounds to [-1,1] and zeroes non-finite", () => {
    expect(clampFloatSample(5)).toBe(1);
    expect(clampFloatSample(-5)).toBe(-1);
    expect(clampFloatSample(0.25)).toBe(0.25);
    expect(clampFloatSample(Number.NaN)).toBe(0);
  });

  it("encodes a Float32 buffer to little-endian Int16 bytes of exact length", () => {
    const pcm = Float32Array.from([0, 1, -1, 0.5]);
    const bytes = floatPcmToInt16Bytes(pcm);
    expect(bytes.byteLength).toBe(pcm.length * 2);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
    expect(view.getInt16(6, true)).toBe(Math.round(0.5 * 0x7fff));
  });

  it("round-trips Float32 → Int16 bytes → Float32 within one quantization step", () => {
    const original = Float32Array.from([0, 0.25, -0.25, 0.9, -0.9, 0.001, -0.001]);
    const decoded = int16BytesToFloatPcm(floatPcmToInt16Bytes(original));
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 1) {
      // 1 LSB @ int16 ≈ 1/32767 ≈ 3.05e-5.
      expect(Math.abs(decoded[i] - original[i])).toBeLessThan(3.1e-5 * 2);
    }
  });

  it("int16SampleToFloat inverts floatSampleToInt16 at the boundaries", () => {
    expect(int16SampleToFloat(32767)).toBeCloseTo(1, 6);
    expect(int16SampleToFloat(-32768)).toBeCloseTo(-1, 6);
    expect(int16SampleToFloat(0)).toBe(0);
  });

  it("ignores a trailing odd byte when decoding (defensive)", () => {
    const bytes = new Uint8Array(3); // 1.5 samples → 1 decodable
    const decoded = int16BytesToFloatPcm(bytes);
    expect(decoded.length).toBe(1);
  });

  it("downmixes multi-channel to mono by averaging", () => {
    const left = Float32Array.from([1, 0, -1]);
    const right = Float32Array.from([0, 0, 1]);
    const mono = downmixChannelsToMono([left, right]);
    expect(Array.from(mono)).toEqual([0.5, 0, 0]);
    // single channel passes through
    expect(downmixChannelsToMono([left])).toBe(left);
    expect(downmixChannelsToMono([]).length).toBe(0);
  });
});
