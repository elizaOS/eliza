import { describe, expect, it } from "vitest";
import { concatFloat32, float32ToWav, wavToFloat32 } from "../wav";

describe("float32ToWav", () => {
  it("writes a canonical 44-byte mono 16-bit PCM header", () => {
    const wav = float32ToWav(new Float32Array(160), 16_000);
    expect(wav.length).toBe(44 + 160 * 2);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(36 + 160 * 2);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(160 * 2);
  });

  it("round-trips sample values within 16-bit quantization error", () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123, -0.987]);
    const { samples, sampleRate } = wavToFloat32(float32ToWav(src));
    expect(sampleRate).toBe(16_000);
    expect(samples.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(samples[i] - src[i])).toBeLessThan(1 / 0x7fff + 1e-6);
    }
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const { samples } = wavToFloat32(float32ToWav(new Float32Array([2.5, -3])));
    expect(samples[0]).toBeCloseTo(1, 3);
    expect(samples[1]).toBeCloseTo(-1, 3);
  });
});

describe("concatFloat32", () => {
  it("concatenates chunks in order", () => {
    const out = concatFloat32([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
