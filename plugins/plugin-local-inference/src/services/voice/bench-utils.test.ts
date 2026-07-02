import { describe, expect, it } from "vitest";
import {
	attributeByEnrollment,
	buildSpeakerTimeline,
	mixAtSnr,
	quasiMonotonicViolations,
} from "./bench-utils";
import { estimateSnrDb, measureRms } from "./corpus-augment";

function tone(freq: number, seconds: number, sampleRate: number, amp = 0.3) {
	const pcm = new Float32Array(Math.round(seconds * sampleRate));
	for (let i = 0; i < pcm.length; i++) {
		pcm[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
	}
	return pcm;
}

describe("mixAtSnr", () => {
	it("hits the requested SNR within 0.5 dB and tiles short noise", () => {
		const clean = tone(220, 2, 16_000);
		const noise = tone(3_000, 0.5, 16_000, 0.2); // shorter than clean → tiled
		for (const snr of [20, 5, -5]) {
			const mixed = mixAtSnr(clean, noise, snr);
			const noiseOnly = new Float32Array(mixed.length);
			for (let i = 0; i < mixed.length; i++) noiseOnly[i] = mixed[i] - clean[i];
			const achieved = estimateSnrDb(measureRms(clean), measureRms(noiseOnly));
			expect(Math.abs(achieved - snr)).toBeLessThan(0.5);
		}
	});

	it("rejects an empty noise track", () => {
		expect(() =>
			mixAtSnr(tone(220, 1, 16_000), new Float32Array(0), 10),
		).toThrow(/empty noise/);
	});
});

describe("quasiMonotonicViolations", () => {
	it("accepts a monotone WER-vs-SNR curve", () => {
		const curve = [
			{ snrDb: 20, wer: 0.1 },
			{ snrDb: 10, wer: 0.15 },
			{ snrDb: 0, wer: 0.6 },
			{ snrDb: -5, wer: 0.95 },
		];
		expect(quasiMonotonicViolations(curve, 0.1)).toEqual([]);
	});

	it("tolerates small inversions within tol but flags collapses", () => {
		const wobble = [
			{ snrDb: 20, wer: 0.18 }, // slightly worse than 10 dB — within tol
			{ snrDb: 10, wer: 0.12 },
			{ snrDb: 0, wer: 0.5 },
		];
		expect(quasiMonotonicViolations(wobble, 0.1)).toEqual([]);
		const collapse = [
			{ snrDb: 20, wer: 0.9 }, // quality collapsed with LESS noise → gate
			{ snrDb: 10, wer: 0.2 },
			{ snrDb: 0, wer: 0.5 },
		];
		const violations = quasiMonotonicViolations(collapse, 0.1);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/@ 20dB/);
	});
});

describe("buildSpeakerTimeline", () => {
	it("lays out turns with gaps and exact ground-truth segments", () => {
		const a = tone(200, 1, 16_000);
		const b = tone(400, 0.5, 16_000);
		const { pcm, segments } = buildSpeakerTimeline(
			[
				{ speaker: "A", pcm: a },
				{ speaker: "B", pcm: b },
			],
			16_000,
			500,
		);
		// gap + a + gap + b + gap
		expect(pcm.length).toBe(8_000 + 16_000 + 8_000 + 8_000 + 8_000);
		expect(segments).toEqual([
			{ speaker: "A", startMs: 500, endMs: 1_500 },
			{ speaker: "B", startMs: 2_000, endMs: 2_500 },
		]);
		// audio actually lands where the segments claim
		expect(pcm[7_999]).toBe(0);
		expect(Math.abs(pcm[8_001])).toBeGreaterThan(0);
	});
});

describe("attributeByEnrollment", () => {
	const A = [1, 0, 0];
	const B = [0, 1, 0];
	const nearA = [0.95, 0.05, 0];
	const nearB = [0.05, 0.95, 0];

	it("attributes turns to the nearest enrolled speaker and scores accuracy", () => {
		const score = attributeByEnrollment([
			{ id: "1", speaker: "A", embedding: A }, // enrolls A
			{ id: "2", speaker: "B", embedding: B }, // enrolls B
			{ id: "3", speaker: "A", embedding: nearA },
			{ id: "4", speaker: "B", embedding: nearB },
			{ id: "5", speaker: "A", embedding: nearB }, // deliberate confusion
		]);
		expect(score.scored).toBe(3);
		expect(score.correct).toBe(2);
		expect(score.accuracy).toBeCloseTo(2 / 3);
		expect(score.perTurn[2].attributed).toBe("B");
		expect(score.perTurn[2].correct).toBe(false);
		expect(score.margin).toBeGreaterThan(0);
	});

	it("requires two speakers", () => {
		expect(() =>
			attributeByEnrollment([{ id: "1", speaker: "A", embedding: A }]),
		).toThrow(/two speakers/);
	});
});
