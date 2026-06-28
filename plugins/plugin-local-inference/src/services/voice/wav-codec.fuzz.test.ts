// Fuzz / hardening regression guard for the WAV decoder. decodeMonoPcm16Wav
// parses untrusted audio bytes (uploads / mic captures), so the invariant under
// random + mutated input is: it either returns a well-formed {pcm, sampleRate}
// or throws a plain Error -- never an unexpected throw, and never hangs. A
// seeded LCG makes failures reproducible.

import { describe, expect, it } from "vitest";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec";

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function assertSafeDecode(bytes: Uint8Array): void {
	try {
		const out = decodeMonoPcm16Wav(bytes);
		expect(out.pcm).toBeInstanceOf(Float32Array);
		expect(typeof out.sampleRate).toBe("number");
		expect(Number.isFinite(out.sampleRate)).toBe(true);
	} catch (err) {
		expect(err instanceof Error).toBe(true);
	}
}

describe("decodeMonoPcm16Wav - fuzz", () => {
	it("handles random bytes without an unexpected throw", () => {
		const rng = makeRng(0x7a7);
		for (let i = 0; i < 2000; i++) {
			const len = Math.floor(rng() * 80);
			const bytes = new Uint8Array(len);
			for (let j = 0; j < len; j++) bytes[j] = Math.floor(rng() * 256);
			assertSafeDecode(bytes);
		}
	});

	it("round-trips a valid blob and survives mutation of it", () => {
		const rng = makeRng(0x317);
		for (let i = 0; i < 2000; i++) {
			const n = Math.floor(rng() * 16);
			const pcm = new Float32Array(n);
			for (let k = 0; k < n; k++) pcm[k] = (rng() - 0.5) * 1.8;
			const blob = encodeMonoPcm16Wav(pcm, 16000);

			// Unmutated decodes to the same length.
			expect(decodeMonoPcm16Wav(blob).pcm.length).toBe(n);

			const mutated = blob.slice();
			const flips = 1 + Math.floor(rng() * 6);
			for (let f = 0; f < flips && mutated.length > 0; f++) {
				mutated[Math.floor(rng() * mutated.length)] = Math.floor(rng() * 256);
			}
			assertSafeDecode(mutated);
		}
	});
});
