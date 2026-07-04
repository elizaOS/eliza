/** Covers the greedy speaker-mapping fallback in `computeDiarizationErrorRate`. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	computeDiarizationErrorRate,
	type DerResult,
	type DiarizationSegment,
} from "./diarization-error-rate";

/**
 * Greedy-branch coverage for the DER scorer (issue #9147).
 *
 * `bestMapping` has two arms: an exact injective permutation search for small
 * speaker counts, and an O(n²) greedy fallback once `refSpeakers.length +
 * hypSpeakers.length > maxExactSpeakers` (default 7) — the existing
 * `diarization-error-rate.test.ts` only ever hits the exact arm. A 7+-speaker
 * conversation (a noisy multi-party room, the very case `maxDer` exists to
 * guard) takes the greedy path, so this pins:
 *   - greedy fires both when forced via a low `maxExactSpeakers` AND on a
 *     genuine 4-ref/4-hyp (=8 combined) conversation under the default,
 *   - the greedy mapping stays injective (no ref or hyp reused — the
 *     usedHyp/usedRef guard), and
 *   - greedy reproduces the exact arm's DER on separable inputs (where greedy
 *     is provably optimal), so the fallback is not silently wrong.
 */

const seg = (
	speaker: string,
	startMs: number,
	endMs: number,
): DiarizationSegment => ({ speaker, startMs, endMs });

/** A hyp→ref mapping must be injective: every hyp key distinct (free) AND every
 * ref value distinct (the property the greedy usedRef guard enforces). */
function expectInjective(mapping: DerResult["mapping"]): void {
	const hyps = Object.keys(mapping);
	const refs = Object.values(mapping);
	expect(new Set(hyps).size).toBe(hyps.length);
	expect(new Set(refs).size).toBe(refs.length);
}

describe("computeDiarizationErrorRate — greedy mapping fallback", () => {
	it("forces the greedy arm via a low maxExactSpeakers and still scores a perfect 2-speaker match", () => {
		const reference = [seg("alice", 0, 1000), seg("bob", 1000, 2000)];
		const hypothesis = [seg("spk0", 0, 1000), seg("spk1", 1000, 2000)];
		// 2 + 2 = 4 combined > maxExact 3 → greedy path (would be exact by default).
		const result = computeDiarizationErrorRate(reference, hypothesis, {
			maxExactSpeakers: 3,
		});
		expect(result.der).toBe(0);
		expect(result.confusionMs).toBe(0);
		expect(result.mapping).toEqual({ spk0: "alice", spk1: "bob" });
		expectInjective(result.mapping);
	});

	it("takes the greedy path on a genuine 4-speaker / 8-combined conversation (default maxExact 7)", () => {
		// 4 ref + 4 hyp = 8 > 7 default → greedy, no options needed.
		const reference = [
			seg("a", 0, 1000),
			seg("b", 1000, 2000),
			seg("c", 2000, 3000),
			seg("d", 3000, 4000),
		];
		const hypothesis = [
			seg("w", 0, 1000),
			seg("x", 1000, 2000),
			seg("y", 2000, 3000),
			seg("z", 3000, 4000),
		];
		const result = computeDiarizationErrorRate(reference, hypothesis);
		expect(result.der).toBe(0);
		expect(result.totalReferenceMs).toBeCloseTo(4000, -1);
		expect(Object.keys(result.mapping)).toHaveLength(4);
		expectInjective(result.mapping);
	});

	it("greedy attributes a swapped span as confusion, not missed/false-alarm, with a tie-break-invariant DER", () => {
		// 4 ref speakers; the hypothesis reuses label "w" for both a's and d's
		// span. One of those two spans is necessarily a confusion regardless of
		// which the greedy tie-break maps w onto — so the DER is deterministic.
		const reference = [
			seg("a", 0, 1000),
			seg("b", 1000, 2000),
			seg("c", 2000, 3000),
			seg("d", 3000, 4000),
		];
		const hypothesis = [
			seg("w", 0, 1000),
			seg("x", 1000, 2000),
			seg("y", 2000, 3000),
			seg("w", 3000, 4000),
		];
		// 4 ref + 3 hyp = 7 combined; force greedy with maxExact 5.
		const result = computeDiarizationErrorRate(reference, hypothesis, {
			maxExactSpeakers: 5,
		});
		expect(result.missedMs).toBe(0);
		expect(result.falseAlarmMs).toBe(0);
		expect(result.confusionMs).toBeCloseTo(1000, -1); // exactly one swapped span
		expect(result.der).toBeCloseTo(0.25, 2); // 1000 confusion / 4000 ref
		expectInjective(result.mapping); // w mapped once, x and y once each
	});

	it("leaves a zero-overlap hypothesis speaker unmapped (greedy skips s<=0 pairs → false alarm)", () => {
		const reference = [seg("a", 0, 1000), seg("b", 1000, 2000)];
		// spk2 talks over a stretch with no reference speaker at all (2000-3000).
		const hypothesis = [
			seg("h0", 0, 1000),
			seg("h1", 1000, 2000),
			seg("h2", 2000, 3000),
		];
		const result = computeDiarizationErrorRate(reference, hypothesis, {
			maxExactSpeakers: 4,
		});
		// h2 never co-occurs with any ref speaker → no mapping entry for it.
		expect(result.mapping.h2).toBeUndefined();
		expect(result.falseAlarmMs).toBeCloseTo(1000, -1);
		expectInjective(result.mapping);
	});

	it("greedy reproduces the exact arm's DER on a separable 3-speaker case", () => {
		const reference = [
			seg("a", 0, 1000),
			seg("b", 1000, 2000),
			seg("c", 2000, 3000),
		];
		const hypothesis = [
			seg("p", 0, 1000),
			seg("q", 1000, 2000),
			seg("p", 2000, 3000), // c collapsed onto p → a confusion either arm
		];
		const exact = computeDiarizationErrorRate(reference, hypothesis, {
			maxExactSpeakers: 16,
		});
		const greedy = computeDiarizationErrorRate(reference, hypothesis, {
			maxExactSpeakers: 0,
		});
		expect(greedy.der).toBeCloseTo(exact.der, 5);
		expect(greedy.confusionMs).toBeCloseTo(exact.confusionMs, -1);
		expectInjective(greedy.mapping);
	});
});
