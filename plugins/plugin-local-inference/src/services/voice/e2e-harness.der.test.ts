/** Covers the voice E2E harness diarization scoring (#9147). Deterministic, fixture inputs. */
import { describe, expect, it } from "vitest";
import { type DiarizationSample, scoreDiarization } from "./e2e-harness";

// #9147 — diarization error rate (DER) is the third heavy voice case the issue
// flags as having a scorer that "does not run anywhere that gates merges". Like
// scoreEchoRejection / scoreOwnerSecurity, scoreDiarization is pure and
// GGUF-independent, so pin its decision math here to give merges an offline gate.
//
// DER here is the per-segment label-agreement form used by the harness:
//   der = (speakerConfusion + missed) / totalReference
// where a null predicted label is a miss and a non-null mismatch is a confusion.

const seg = (
	predictedLabel: string | null,
	expectedLabel: string,
): DiarizationSample => ({ predictedLabel, expectedLabel });

describe("scoreDiarization (#9147)", () => {
	it("perfect alignment (reference == hypothesis) → DER 0, passes", () => {
		const r = scoreDiarization([
			seg("alice", "alice"),
			seg("bob", "bob"),
			seg("alice", "alice"),
			seg("bob", "bob"),
		]);
		expect(r.total).toBe(4);
		expect(r.confusions).toBe(0);
		expect(r.misses).toBe(0);
		expect(r.der).toBe(0);
		expect(r.passed).toBe(true);
	});

	it("one swapped speaker over four turns → DER 0.25 (1 confusion / 4)", () => {
		const r = scoreDiarization([
			seg("alice", "alice"),
			seg("alice", "bob"), // swapped: predicted alice, truth bob → confusion
			seg("alice", "alice"),
			seg("bob", "bob"),
		]);
		expect(r.total).toBe(4);
		expect(r.confusions).toBe(1);
		expect(r.misses).toBe(0);
		expect(r.der).toBe(0.25); // (1 + 0) / 4
		expect(r.passed).toBe(false); // 0.25 > default maxDer 0.2
	});

	it("one missed segment over four turns → DER 0.25 (1 miss / 4)", () => {
		const r = scoreDiarization([
			seg("alice", "alice"),
			seg(null, "bob"), // missed: no predicted label → miss
			seg("alice", "alice"),
			seg("bob", "bob"),
		]);
		expect(r.total).toBe(4);
		expect(r.confusions).toBe(0);
		expect(r.misses).toBe(1);
		expect(r.der).toBe(0.25); // (0 + 1) / 4
		expect(r.passed).toBe(false); // 0.25 > default maxDer 0.2
	});

	it("empty hypothesis vs non-empty reference → all-missed, DER 1, fails closed", () => {
		const r = scoreDiarization([
			seg(null, "alice"),
			seg(null, "bob"),
			seg(null, "alice"),
		]);
		expect(r.total).toBe(3);
		expect(r.confusions).toBe(0);
		expect(r.misses).toBe(3);
		expect(r.der).toBe(1); // 3 missed / 3 reference
		expect(r.passed).toBe(false);
	});

	it("fails closed on an empty sample set (nothing proven)", () => {
		const r = scoreDiarization([]);
		expect(r.total).toBe(0);
		expect(r.der).toBe(0);
		expect(r.passed).toBe(false);
	});

	it("honors a custom maxDer floor", () => {
		// 1 confusion over 5 → DER 0.2, exactly the default ceiling.
		const samples = [
			seg("alice", "alice"),
			seg("bob", "alice"), // confusion
			seg("alice", "alice"),
			seg("bob", "bob"),
			seg("alice", "alice"),
		];
		expect(scoreDiarization(samples).der).toBe(0.2);
		expect(scoreDiarization(samples).passed).toBe(true); // 0.2 <= 0.2 default
		expect(scoreDiarization(samples, { maxDer: 0.1 }).passed).toBe(false); // 0.2 > 0.1
	});
});
