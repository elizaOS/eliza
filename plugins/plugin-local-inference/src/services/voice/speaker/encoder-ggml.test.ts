/**
 * Unit coverage for voiceSpeakerDistance (#9147 self-voice-rejection / speaker ID).
 *
 * `voiceSpeakerDistance` is the pure cosine-distance metric (`1 - cos_sim`,
 * range [0,2]) that the diarizer / self-voice-rejection compares against a
 * threshold — small distance = same speaker. It mirrors the C-side
 * `voice_speaker_distance` and shipped untested. No GGUF / FFI / audio.
 */

import { describe, expect, it } from "vitest";
import {
	SPEAKER_GGML_EMBEDDING_DIM as DIM,
	voiceSpeakerDistance,
} from "./encoder-ggml";

const vec = (fill: number) => new Float32Array(DIM).fill(fill);
const unit = (index: number) => {
	const v = new Float32Array(DIM);
	v[index] = 1;
	return v;
};

describe("voiceSpeakerDistance", () => {
	it("is 0 for identical embeddings (same speaker)", () => {
		expect(voiceSpeakerDistance(vec(1), vec(1))).toBeCloseTo(0, 6);
	});

	it("is scale-invariant (cosine ignores magnitude)", () => {
		expect(voiceSpeakerDistance(vec(1), vec(2))).toBeCloseTo(0, 6);
	});

	it("is 1 for orthogonal embeddings", () => {
		expect(voiceSpeakerDistance(unit(0), unit(1))).toBeCloseTo(1, 6);
	});

	it("is 2 for opposite embeddings (max distance)", () => {
		expect(voiceSpeakerDistance(vec(1), vec(-1))).toBeCloseTo(2, 6);
	});

	it("returns 1 when either embedding is the zero vector", () => {
		expect(voiceSpeakerDistance(new Float32Array(DIM), vec(1))).toBe(1);
		expect(voiceSpeakerDistance(vec(1), new Float32Array(DIM))).toBe(1);
	});

	it("is symmetric", () => {
		const a = unit(3);
		const b = vec(1);
		expect(voiceSpeakerDistance(a, b)).toBe(voiceSpeakerDistance(b, a));
	});

	it("throws on a wrong-dimension embedding (either side)", () => {
		expect(() => voiceSpeakerDistance(new Float32Array(8), vec(1))).toThrow(
			/expected 256/,
		);
		expect(() => voiceSpeakerDistance(vec(1), new Float32Array(8))).toThrow(
			/expected 256/,
		);
	});
});
