/** Unit tests for diarization-error-rate computation and the within-budget gate. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	computeDiarizationErrorRate,
	type DiarizationSegment,
	diarizationWithinBudget,
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

	it("penalizes a missed overlapping talker", () => {
		const reference = [seg("alice", 0, 2000), seg("bob", 1000, 2000)];
		const hypothesis = [seg("spk0", 0, 2000)]; // bob's overlapping 1000ms missed
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.missedMs).toBeCloseTo(1000, -1);
		expect(result.der).toBeCloseTo(1000 / 3000, 2);
	});
});

describe("diarizationWithinBudget", () => {
	it("gates a hypothesis against the scenario maxDer", () => {
		expect(diarizationWithinBudget({ der: 0.1 }, 0.15)).toBe(true);
		expect(diarizationWithinBudget({ der: 0.2 }, 0.15)).toBe(false);
		expect(diarizationWithinBudget({ der: 0 }, 0)).toBe(true);
	});
});
