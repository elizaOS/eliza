/** Unit tests for diarization-error-rate computation and the within-budget gate. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	computeDiarizationErrorRate,
	type DiarizationSegment,
	diarizationWithinBudget,
	MAX_DER_DURATION_MS,
	MAX_DER_EXACT_SPEAKERS,
	MAX_DER_FRAMES,
	MAX_DER_SEGMENTS,
	MAX_DER_SPEAKERS,
	MAX_DER_WORK_UNITS,
	MIN_DER_FRAME_MS,
} from "./diarization-error-rate";

/**
 * Diarization Error Rate scorer (issue #9147). The voice scenarios carry a
 * `maxDer` threshold and an `expectedSpeakerLabel` per turn, but nothing
 * computed DER — so a wrong speaker attribution or a missed overlapping talker
 * passed silently. This pins the four DER components (missed / false-alarm /
 * confusion / correct) and the key property that DER is invariant to how the
 * diarizer NAMES its speakers (it's the partition that matters, not the labels).
 */

const seg = (
	speaker: string,
	startMs: number,
	endMs: number,
): DiarizationSegment => ({
	speaker,
	startMs,
	endMs,
});

describe("computeDiarizationErrorRate", () => {
	it("is 0 for a perfect match (even with different speaker label names)", () => {
		const reference = [seg("alice", 0, 1000), seg("bob", 1000, 2000)];
		// hypothesis splits the timeline identically but calls them spk0/spk1.
		const hypothesis = [seg("spk0", 0, 1000), seg("spk1", 1000, 2000)];
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.der).toBe(0);
		expect(result.confusionMs).toBe(0);
		// optimal mapping pairs the equivalent speakers.
		expect(result.mapping).toEqual({ spk0: "alice", spk1: "bob" });
	});

	it("counts missed speech when the system misses a speaker", () => {
		const reference = [seg("alice", 0, 1000), seg("bob", 1000, 2000)];
		const hypothesis = [seg("spk0", 0, 1000)]; // bob's 1000ms missed entirely
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.missedMs).toBeCloseTo(1000, -1);
		expect(result.der).toBeCloseTo(0.5, 1); // 1000 missed / 2000 ref
	});

	it("counts false alarm when the system hallucinates speech", () => {
		const reference = [seg("alice", 0, 1000)];
		const hypothesis = [seg("spk0", 0, 1000), seg("spk1", 1000, 2000)];
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.falseAlarmMs).toBeCloseTo(1000, -1);
		expect(result.totalReferenceMs).toBeCloseTo(1000, -1);
	});

	it("counts confusion when the same span is attributed to a swapped speaker", () => {
		// 3 distinct ref speakers; hypothesis collapses the 3rd onto speaker 1's id,
		// so the 3rd span is a confusion (wrong speaker), not missed or false alarm.
		const reference = [
			seg("a", 0, 1000),
			seg("b", 1000, 2000),
			seg("c", 2000, 3000),
		];
		const hypothesis = [
			seg("x", 0, 1000),
			seg("y", 1000, 2000),
			seg("x", 2000, 3000),
		];
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.missedMs).toBe(0);
		expect(result.falseAlarmMs).toBe(0);
		expect(result.confusionMs).toBeCloseTo(1000, -1); // c's span mapped to x≠c
		expect(result.der).toBeCloseTo(1 / 3, 2);
	});

	it("handles overlapping speech (both speakers active in one span)", () => {
		// alice 0-2000, bob 1000-2000 → 1000ms of overlap (2 ref speakers).
		const reference = [seg("alice", 0, 2000), seg("bob", 1000, 2000)];
		const hypothesis = [seg("spk0", 0, 2000), seg("spk1", 1000, 2000)];
		const result = computeDiarizationErrorRate(reference, hypothesis);
		// ref speaker-time = 2000 (alice) + 1000 (bob overlap) = 3000ms.
		expect(result.totalReferenceMs).toBeCloseTo(3000, -1);
		expect(result.der).toBe(0); // perfectly diarized overlap
	});

	it("keeps a speaker active across overlapping segments with the same label", () => {
		const reference = [seg("alice", 0, 200), seg("alice", 100, 300)];
		const hypothesis = [seg("spk0", 0, 300)];
		const result = computeDiarizationErrorRate(reference, hypothesis, {
			frameMs: 100,
		});
		expect(result.totalReferenceMs).toBe(300);
		expect(result.der).toBe(0);
	});

	it("penalizes a missed overlapping talker", () => {
		const reference = [seg("alice", 0, 2000), seg("bob", 1000, 2000)];
		const hypothesis = [seg("spk0", 0, 2000)]; // bob's overlapping 1000ms missed
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.missedMs).toBeCloseTo(1000, -1);
		expect(result.der).toBeCloseTo(1000 / 3000, 2);
	});

	it("fails closed on a hostile timeline instead of allocating millions of frames", () => {
		const started = performance.now();
		expect(() =>
			computeDiarizationErrorRate(
				[seg("alice", 0, MAX_DER_DURATION_MS + 1)],
				[seg("spk0", 0, MAX_DER_DURATION_MS + 1)],
			),
		).toThrow(/exceeds/);
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("fails closed on a sub-millisecond frame that would explode frame count", () => {
		expect(() =>
			computeDiarizationErrorRate(
				[seg("alice", 0, 1000)],
				[seg("spk0", 0, 1000)],
				{
					frameMs: MIN_DER_FRAME_MS / 10,
				},
			),
		).toThrow(/frameMs/);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
		"rejects malformed frame size %s instead of substituting the default",
		(frameMs) => {
			expect(() =>
				computeDiarizationErrorRate(
					[seg("alice", 0, 1000)],
					[seg("spk0", 0, 1000)],
					{ frameMs },
				),
			).toThrow(/frameMs/);
		},
	);

	it("bounds the duration/frame product before sweeping the timeline", () => {
		const score = () =>
			computeDiarizationErrorRate(
				[seg("alice", 0, MAX_DER_FRAMES + 1)],
				[seg("spk0", 0, MAX_DER_FRAMES + 1)],
				{ frameMs: 1 },
			);
		expect(score).toThrow(new RegExp(`${MAX_DER_FRAMES} frames`));
		try {
			score();
		} catch (error) {
			expect(error).toMatchObject({ code: "DIARIZATION_SCORE_UNBOUNDED" });
		}
	});

	it("rejects inverted segments instead of silently dropping them", () => {
		expect(() =>
			computeDiarizationErrorRate([seg("alice", 20, 10)], [seg("spk0", 0, 10)]),
		).toThrow(/greater than or equal/);
	});

	it("bounds sparse segment arrays before iterating their holes", () => {
		const sparse = new Array<DiarizationSegment>(MAX_DER_SEGMENTS + 1);
		expect(() => computeDiarizationErrorRate(sparse, [])).toThrow(
			new RegExp(`${MAX_DER_SEGMENTS} combined segments`),
		);
	});

	it("bounds unique speaker cardinality before constructing the mapping matrix", () => {
		const reference = Array.from(
			{ length: MAX_DER_SPEAKERS / 2 + 1 },
			(_, index) => seg(`r${index}`, 0, 0),
		);
		const hypothesis = Array.from(
			{ length: MAX_DER_SPEAKERS / 2 },
			(_, index) => seg(`h${index}`, 0, 0),
		);
		expect(() => computeDiarizationErrorRate(reference, hypothesis)).toThrow(
			new RegExp(`${MAX_DER_SPEAKERS} combined speakers`),
		);
	});

	it("bounds overlap-amplified co-occurrence work", () => {
		const speakersPerSide = 40;
		const frames = Math.floor(MAX_DER_WORK_UNITS / speakersPerSide ** 2) + 1;
		const reference = Array.from({ length: speakersPerSide }, (_, index) =>
			seg(`r${index}`, 0, frames),
		);
		const hypothesis = Array.from({ length: speakersPerSide }, (_, index) =>
			seg(`h${index}`, 0, frames),
		);
		expect(() =>
			computeDiarizationErrorRate(reference, hypothesis, { frameMs: 1 }),
		).toThrow(new RegExp(`${MAX_DER_WORK_UNITS} bounded work units`));
	});

	it("keeps the factorial mapping threshold within its proven safe ceiling", () => {
		expect(() =>
			computeDiarizationErrorRate([seg("alice", 0, 10)], [seg("spk0", 0, 10)], {
				maxExactSpeakers: MAX_DER_EXACT_SPEAKERS + 1,
			}),
		).toThrow(/maxExactSpeakers/);
	});

	it("maps prototype-like speaker labels without mutating the result object", () => {
		const result = computeDiarizationErrorRate(
			[seg("constructor", 0, 100)],
			[seg("__proto__", 0, 100)],
		);
		expect(Object.hasOwn(result.mapping, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(result.mapping, "__proto__")?.value,
		).toBe("constructor");
		expect(result.der).toBe(0);
	});
});

describe("diarizationWithinBudget", () => {
	it("gates a hypothesis against the scenario maxDer", () => {
		expect(diarizationWithinBudget({ der: 0.1 }, 0.15)).toBe(true);
		expect(diarizationWithinBudget({ der: 0.2 }, 0.15)).toBe(false);
		expect(diarizationWithinBudget({ der: 0 }, 0)).toBe(true);
	});
});
