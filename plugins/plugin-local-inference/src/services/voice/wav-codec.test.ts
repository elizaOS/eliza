/** Unit tests for WAV encode/decode round-trips. Deterministic. */
import { describe, expect, it } from "vitest";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec";

describe("wav-codec", () => {
	it("round-trips mono PCM16 within quantization error", () => {
		const pcm = new Float32Array(256);
		for (let i = 0; i < pcm.length; i++) {
			pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.5;
		}
		const wav = encodeMonoPcm16Wav(pcm, 16_000);
		const decoded = decodeMonoPcm16Wav(wav);
		expect(decoded.sampleRate).toBe(16_000);
		expect(decoded.pcm.length).toBe(pcm.length);
		for (let i = 0; i < pcm.length; i++) {
			expect(Math.abs(decoded.pcm[i] - pcm[i])).toBeLessThan(1 / 0x7fff + 1e-6);
		}
	});

	it("clamps out-of-range samples and emits a 44-byte header", () => {
		const wav = encodeMonoPcm16Wav(Float32Array.from([2, -2, 0]), 24_000);
		expect(wav.length).toBe(44 + 3 * 2);
		const decoded = decodeMonoPcm16Wav(wav);
		expect(decoded.sampleRate).toBe(24_000);
		expect(decoded.pcm[0]).toBeCloseTo(1, 3);
		expect(decoded.pcm[1]).toBeCloseTo(-1, 3);
	});

	it("rejects non-WAV / truncated input (fail loud)", () => {
		expect(() => decodeMonoPcm16Wav(new Uint8Array(10))).toThrow(/too short/);
		expect(() => decodeMonoPcm16Wav(new Uint8Array(64))).toThrow(/WAV/);
	});
});
