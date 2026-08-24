/** Verifies voice-session-pcm Float32↔Int16 correctness (golden vectors) through the package's configured test harness. */
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
    const original = Float32Array.from([
      0, 0.25, -0.25, 0.9, -0.9, 0.001, -0.001,
    ]);
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

describe("voice-session-pcm clamp and asymmetric scale edges", () => {
  it("clampFloatSample saturates non-finite infinities to the rails", () => {
    expect(clampFloatSample(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampFloatSample(Number.NEGATIVE_INFINITY)).toBe(-1);
  });

  it("clampFloatSample passes the exact rails through unchanged", () => {
    expect(clampFloatSample(1)).toBe(1);
    expect(clampFloatSample(-1)).toBe(-1);
  });

  it("floatSampleToInt16 rounds nearest without drifting at quarter scale", () => {
    // 0.25 * 32767 = 8191.75 -> 8192; -0.25 lands exactly on -8192.
    expect(floatSampleToInt16(0.25)).toBe(8192);
    expect(floatSampleToInt16(-0.25)).toBe(-8192);
  });

  it("int16SampleToFloat is exact on representable negative depths", () => {
    // Negative side divides by 32768, so power-of-two depths are exact.
    expect(int16SampleToFloat(-16384)).toBe(-0.5);
    expect(int16SampleToFloat(-32768)).toBe(-1);
  });

  it("int16SampleToFloat uses the shallower positive divisor", () => {
    expect(int16SampleToFloat(16384)).toBe(16384 / 0x7fff);
    expect(int16SampleToFloat(32767)).toBe(1);
  });
});

describe("voice-session-pcm buffer framing edges", () => {
  it("encodes an empty Float32 buffer to a zero-length Uint8Array", () => {
    const bytes = floatPcmToInt16Bytes(new Float32Array(0));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(0);
  });

  it("returns a fresh output buffer per encode and leaves input untouched", () => {
    const pcm = Float32Array.from([1, -1]);
    const first = floatPcmToInt16Bytes(pcm);
    const second = floatPcmToInt16Bytes(pcm);
    expect(first).not.toBe(second);
    expect(Array.from(pcm)).toEqual([1, -1]);
  });

  it("decodes a frame sliced at a non-zero byteOffset of a larger buffer", () => {
    // Socket frames arrive as views into a shared receive buffer.
    const receiveBuffer = new Uint8Array([0xff, 0xff, 0x00, 0x80]).subarray(2);
    expect(receiveBuffer.byteOffset).toBe(2);
    const decoded = int16BytesToFloatPcm(receiveBuffer);
    expect(Array.from(decoded)).toEqual([-1]);
  });

  it("keeps every whole sample and drops only the odd trailing byte", () => {
    // 0x8000 LE = -32768 -> -1; the trailing 0xAA byte is not a sample.
    const bytes = new Uint8Array([0x00, 0x80, 0xaa]);
    const decoded = int16BytesToFloatPcm(bytes);
    expect(decoded.length).toBe(1);
    expect(decoded[0]).toBe(-1);
  });
});

describe("voice-session-pcm downmix edges", () => {
  it("treats a shorter channel's missing tail as silence instead of NaN", () => {
    const long = Float32Array.from([0.5, 0.5]);
    const short = Float32Array.from([0]);
    const mono = downmixChannelsToMono([long, short]);
    expect(Array.from(mono)).toEqual([0.25, 0.25]);
  });

  it("averages three channels per frame", () => {
    const mono = downmixChannelsToMono([
      Float32Array.from([3]),
      Float32Array.from([-1]),
      Float32Array.from([1]),
    ]);
    expect(Array.from(mono)).toEqual([1]);
  });

  it("sizes the output by the first channel's length", () => {
    const first = Float32Array.from([2]);
    const longer = Float32Array.from([2, 2, 2]);
    const mono = downmixChannelsToMono([first, longer]);
    expect(mono.length).toBe(1);
    expect(Array.from(mono)).toEqual([2]);
  });
});
