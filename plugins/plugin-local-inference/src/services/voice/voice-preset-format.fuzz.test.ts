// Mutation + random-byte fuzz for the voice-preset binary parser.
// readVoicePresetFile is documented as "the single defensive boundary for the
// format", so the hardening invariant is: on ANY bytes it either returns a
// well-formed VoicePresetFile or throws a VoicePresetFormatError -- never an
// unexpected RangeError/TypeError from an unchecked DataView read. A seeded LCG
// makes failures reproducible.

import { describe, expect, it } from "vitest";
import {
	readVoicePresetFile,
	VoicePresetFormatError,
	writeVoicePresetFileV2,
} from "./voice-preset-format";

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function randomFloat32(rng: () => number, n: number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (rng() - 0.5) * 4;
	return out;
}

function validBlob(rng: () => number): Uint8Array {
	const phrases = Array.from({ length: Math.floor(rng() * 3) }, (_, i) => ({
		text: `phrase ${i}`,
		sampleRate: 24000,
		pcm: randomFloat32(rng, Math.floor(rng() * 8)),
	}));
	return writeVoicePresetFileV2({
		embedding: randomFloat32(rng, Math.floor(rng() * 10)),
		phrases,
		refText: rng() < 0.5 ? "reference" : "",
		instruct: rng() < 0.5 ? "speak" : "",
		metadata: rng() < 0.5 ? { voice: "af" } : {},
	});
}

/** Either a valid parse or the format's own error -- never anything else. */
function assertSafeParse(bytes: Uint8Array): void {
	let result: ReturnType<typeof readVoicePresetFile> | undefined;
	try {
		result = readVoicePresetFile(bytes);
	} catch (err) {
		expect(
			err instanceof VoicePresetFormatError,
			`expected VoicePresetFormatError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
		).toBe(true);
		return;
	}
	// A non-throwing parse must still be a well-formed record.
	expect(typeof result.version).toBe("number");
	expect(result.embedding).toBeInstanceOf(Float32Array);
	expect(Array.isArray(result.phrases)).toBe(true);
}

describe("readVoicePresetFile - fuzz", () => {
	it("never throws anything but VoicePresetFormatError on random bytes", () => {
		const rng = makeRng(0xb10b);
		for (let i = 0; i < 1500; i++) {
			const len = Math.floor(rng() * 96);
			const bytes = new Uint8Array(len);
			for (let j = 0; j < len; j++) bytes[j] = Math.floor(rng() * 256);
			assertSafeParse(bytes);
		}
	});

	it("never throws anything but VoicePresetFormatError on mutated valid blobs", () => {
		const rng = makeRng(0x7a11);
		for (let i = 0; i < 1500; i++) {
			const blob = validBlob(rng);
			// Round-trip sanity: an unmutated blob parses cleanly.
			expect(() => readVoicePresetFile(blob)).not.toThrow();
			// Now flip a handful of random bytes and re-parse.
			const mutated = blob.slice();
			const flips = 1 + Math.floor(rng() * 6);
			for (let f = 0; f < flips && mutated.length > 0; f++) {
				const idx = Math.floor(rng() * mutated.length);
				mutated[idx] = Math.floor(rng() * 256);
			}
			assertSafeParse(mutated);
		}
	});
});
