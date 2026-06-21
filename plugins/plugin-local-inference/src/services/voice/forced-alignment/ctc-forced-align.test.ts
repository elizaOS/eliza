import { describe, expect, it } from "vitest";
import {
	alignTranscriptSegment,
	alignWords,
	type CtcEmissionProvider,
	type CtcEmissions,
	ctcForcedAlign,
} from "./ctc-forced-align";

// Vocab: blank=0, a=1, b=2, c=3. A "frame" is the per-class natural-log probs.
const lg = (...probs: number[]): number[] => probs.map((p) => Math.log(p));
const A = lg(0.01, 0.97, 0.01, 0.01);
const B = lg(0.01, 0.01, 0.97, 0.01);
const C = lg(0.01, 0.01, 0.01, 0.97);
const BLANK3 = lg(0.97, 0.01, 0.01);

function emissions(logProbs: number[][], frameDurationMs = 10): CtcEmissions {
	return { logProbs, frameDurationMs, blank: 0 };
}

describe("ctcForcedAlign", () => {
	it("aligns two distinct tokens, skipping the optional blank between them", () => {
		const res = ctcForcedAlign(emissions([A, A, B, B]), [1, 2]);
		expect(res.tokens.map((t) => [t.token, t.startFrame, t.endFrame])).toEqual([
			[1, 0, 1],
			[2, 2, 3],
		]);
		// Confidence ≈ exp(log 0.97) per favored frame.
		expect(res.tokens[0].score).toBeGreaterThan(Math.log(0.5));
	});

	it("forces a blank between two IDENTICAL tokens (no skip allowed)", () => {
		// a _ a over 3 frames: the middle frame must be the mandatory blank.
		const res = ctcForcedAlign(
			emissions([lg(0.01, 0.97, 0.01), BLANK3, lg(0.01, 0.97, 0.01)]),
			[1, 1],
		);
		expect(res.tokens.map((t) => [t.startFrame, t.endFrame])).toEqual([
			[0, 0],
			[2, 2],
		]);
	});

	it("returns no tokens when alignment is impossible", () => {
		expect(ctcForcedAlign(emissions([A]), [1, 2]).tokens).toEqual([]); // T<L
		expect(ctcForcedAlign(emissions([A, B]), []).tokens).toEqual([]); // no targets
		expect(ctcForcedAlign(emissions([]), [1]).tokens).toEqual([]); // no frames
	});
});

describe("alignWords", () => {
	it("groups token frame spans into per-word [startMs,endMs]", () => {
		const words = alignWords({
			emissions: emissions([A, A, B, B]),
			targets: [1, 2],
			wordOfToken: [0, 1],
			words: ["a", "b"],
		});
		expect(words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
			["a", 0, 20],
			["b", 20, 40],
		]);
		for (const w of words) {
			expect(w.confidence).toBeGreaterThan(0.5);
			expect(w.confidence).toBeLessThanOrEqual(1);
		}
	});

	it("spans a multi-token word across all its tokens' frames", () => {
		const words = alignWords({
			emissions: emissions([A, B, C]),
			targets: [1, 2, 3], // a b c
			wordOfToken: [0, 0, 1], // "ab" then "c"
			words: ["ab", "c"],
		});
		expect(words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
			["ab", 0, 20],
			["c", 20, 30],
		]);
	});

	it("applies the segment offset to every timing", () => {
		const words = alignWords({
			emissions: emissions([A, A, B, B]),
			targets: [1, 2],
			wordOfToken: [0, 1],
			words: ["a", "b"],
			offsetMs: 1000,
		});
		expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
			[1000, 1020],
			[1020, 1040],
		]);
	});

	it("returns [] when alignment is impossible", () => {
		expect(
			alignWords({
				emissions: emissions([A]),
				targets: [1, 2],
				wordOfToken: [0, 1],
				words: ["a", "b"],
			}),
		).toEqual([]);
	});
});

describe("alignTranscriptSegment", () => {
	const provider: CtcEmissionProvider = {
		available: () => true,
		tokenize: (text) => ({
			targets: [1, 2],
			wordOfToken: [0, 1],
			words: text.split(" "),
		}),
		emit: async () => emissions([A, A, B, B]),
	};

	it("aligns via the provider when available", async () => {
		const words = await alignTranscriptSegment(
			provider,
			new Float32Array(0),
			16000,
			"a b",
		);
		expect(words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
			["a", 0, 20],
			["b", 20, 40],
		]);
	});

	it("degrades to [] when the acoustic model is unavailable", async () => {
		const words = await alignTranscriptSegment(
			{ ...provider, available: () => false },
			new Float32Array(0),
			16000,
			"a b",
		);
		expect(words).toEqual([]);
	});
});
