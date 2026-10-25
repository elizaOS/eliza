/** Covers the voice E2E harness EOT / respond / entity-extraction scoring (#9147). Deterministic, fixture inputs. */
import { describe, expect, it } from "vitest";
import {
	type EotDecisionSample,
	type RespondDecisionSample,
	scoreEntityExtraction,
	scoreEotDecision,
	scoreRespondDecision,
	scoreVoiceEntityMatch,
	summarizeVoiceE2e,
	type VoiceEntityMatchSample,
} from "./e2e-harness";

// #9147 — four more pure, GGUF-independent voice e2e scorers that the issue's
// test matrix relies on but which had no offline coverage (the matrix "scorers
// exist but don't gate merges" gap). Companions to the already-pinned
// scoreDiarization (#9222), scoreEchoRejection, and scoreOwnerSecurity:
//   - scoreRespondDecision  → respond-when-should vs answer-a-bystander (FP/FN)
//   - scoreEotDecision      → VAD/EOT don't false-trigger (noise/music rows)
//   - scoreEntityExtraction → owner-inference entity precision/recall/f1
//   - scoreVoiceEntityMatch → recognized voice resolves to the right entity
// All are pure decision math, so they give merges an offline gate today; the
// real-audio lanes stay blocked on the pending speaker-encoder/diarizer GGUFs.

const eot = (
	decided: boolean,
	expected: boolean,
	latencyMs?: number,
): EotDecisionSample => ({ decided, expected, latencyMs });

const respond = (
	responded: boolean,
	expectRespond: boolean,
): RespondDecisionSample => ({ responded, expectRespond });

const match = (
	matchedEntityId: string | null,
	expectedEntityId: string,
): VoiceEntityMatchSample => ({ matchedEntityId, expectedEntityId });

describe("scoreEotDecision (#9147)", () => {
	it("perfect EOT decisions → 0 false-trigger / 0 false-suppress, passes", () => {
		const r = scoreEotDecision([
			eot(true, true, 120),
			eot(false, false),
			eot(true, true, 80),
			eot(false, false),
		]);
		expect(r.total).toBe(4);
		expect(r.falseTriggerRate).toBe(0);
		expect(r.falseSuppressionRate).toBe(0);
		expect(r.accuracy).toBe(1);
		expect(r.latencyP50Ms).not.toBeNull();
		expect(r.passed).toBe(true);
	});

	it("a single false trigger over 4 turns exceeds the default 0.1 ceiling → fails", () => {
		// decided where there was NO real boundary = jumped in over a noise/music
		// false-trigger; 1/4 = 0.25 > 0.1.
		const r = scoreEotDecision([
			eot(true, false, 50), // false trigger
			eot(false, false),
			eot(true, true, 90),
			eot(false, false),
		]);
		expect(r.falseTriggerRate).toBe(0.25);
		expect(r.passed).toBe(false);
	});

	it("false suppression alone does NOT fail the gate (only false-trigger gates)", () => {
		// held when it should have ended the turn; falseTriggerRate stays 0.
		const r = scoreEotDecision([
			eot(false, true), // missed boundary
			eot(false, false),
			eot(true, true, 60),
			eot(false, false),
		]);
		expect(r.falseSuppressionRate).toBe(0.25);
		expect(r.falseTriggerRate).toBe(0);
		expect(r.passed).toBe(true);
	});

	it("a relaxed maxFalseTriggerRate admits the borderline case", () => {
		const r = scoreEotDecision(
			[
				eot(true, false, 40),
				eot(false, false),
				eot(true, true, 70),
				eot(false, false),
			],
			{ maxFalseTriggerRate: 0.25 },
		);
		expect(r.falseTriggerRate).toBe(0.25);
		expect(r.passed).toBe(true);
	});

	it("latency percentiles are null when no decided turn carries a latency", () => {
		const r = scoreEotDecision([eot(true, true), eot(false, false)]);
		expect(r.latencyP50Ms).toBeNull();
		expect(r.latencyP95Ms).toBeNull();
	});

	it("empty sample set fails closed (no evidence the gate works)", () => {
		const r = scoreEotDecision([]);
		expect(r.total).toBe(0);
		expect(r.passed).toBe(false);
	});
});

describe("scoreRespondDecision (#9147)", () => {
	it("all decisions correct → accuracy 1, no FP/FN, passes", () => {
		const r = scoreRespondDecision([
			respond(true, true),
			respond(false, false),
			respond(true, true),
			respond(false, false),
		]);
		expect(r.total).toBe(4);
		expect(r.accuracy).toBe(1);
		expect(r.falsePositiveRate).toBe(0);
		expect(r.falseNegativeRate).toBe(0);
		expect(r.passed).toBe(true);
	});

	it("answering a bystander is a false positive scored over the should-NOT turns", () => {
		// 2 should-not turns, 1 answered → FPR 0.5; accuracy 3/4 = 0.75 < 0.9.
		const r = scoreRespondDecision([
			respond(true, true),
			respond(true, false), // answered a bystander
			respond(false, false),
			respond(true, true),
		]);
		expect(r.falsePositiveRate).toBe(0.5);
		expect(r.falseNegativeRate).toBe(0);
		expect(r.accuracy).toBe(0.75);
		expect(r.passed).toBe(false);
	});

	it("staying silent on a real turn is a false negative scored over the should turns", () => {
		// 3 should turns, 1 missed → FNR 1/3 ≈ 0.3333.
		const r = scoreRespondDecision([
			respond(true, true),
			respond(false, true), // missed a real turn
			respond(true, true),
			respond(false, false),
		]);
		expect(r.falseNegativeRate).toBe(0.3333);
		expect(r.falsePositiveRate).toBe(0);
		expect(r.passed).toBe(false);
	});

	it("a high enough accuracy passes the default 0.9 gate", () => {
		const samples = [
			...Array.from({ length: 9 }, () => respond(true, true)),
			respond(true, false), // one bystander answered
		];
		const r = scoreRespondDecision(samples);
		expect(r.accuracy).toBe(0.9);
		expect(r.passed).toBe(true);
	});

	it("empty sample set fails closed", () => {
		const r = scoreRespondDecision([]);
		expect(r.total).toBe(0);
		expect(r.passed).toBe(false);
	});
});

describe("scoreEntityExtraction (#9147)", () => {
	it("exact match (case/whitespace-insensitive) → precision/recall/f1 = 1", () => {
		const r = scoreEntityExtraction({
			expected: ["Alice", "Bob"],
			inferred: ["alice ", " BOB"],
		});
		expect(r.precision).toBe(1);
		expect(r.recall).toBe(1);
		expect(r.f1).toBe(1);
		expect(r.passed).toBe(true);
	});

	it("an extra inferred entity lowers precision; a missed one lowers recall", () => {
		const r = scoreEntityExtraction({
			expected: ["alice", "bob"],
			inferred: ["alice", "carol"],
		});
		// tp=1, precision 1/2=0.5, recall 1/2=0.5, f1=0.5 < 0.8.
		expect(r.precision).toBe(0.5);
		expect(r.recall).toBe(0.5);
		expect(r.f1).toBe(0.5);
		expect(r.passed).toBe(false);
	});

	it("both sides empty → vacuously perfect (precision/recall/f1 = 1, passes)", () => {
		const r = scoreEntityExtraction({ expected: [], inferred: [] });
		expect(r.precision).toBe(1);
		expect(r.recall).toBe(1);
		expect(r.f1).toBe(1);
		expect(r.passed).toBe(true);
	});

	it("inferring entities when none were expected → precision 0, f1 0, fails", () => {
		const r = scoreEntityExtraction({ expected: [], inferred: ["alice"] });
		expect(r.precision).toBe(0);
		expect(r.recall).toBe(1);
		expect(r.f1).toBe(0);
		expect(r.passed).toBe(false);
	});

	it("a custom minF1 admits a partial match", () => {
		const r = scoreEntityExtraction(
			{ expected: ["alice", "bob"], inferred: ["alice", "carol"] },
			{ minF1: 0.5 },
		);
		expect(r.f1).toBe(0.5);
		expect(r.passed).toBe(true);
	});
});

describe("scoreVoiceEntityMatch (#9147)", () => {
	it("every recognized voice resolves to the right entity → matchRate 1, passes", () => {
		const r = scoreVoiceEntityMatch([
			match("owner-1", "owner-1"),
			match("guest-2", "guest-2"),
		]);
		expect(r.total).toBe(2);
		expect(r.correct).toBe(2);
		expect(r.matchRate).toBe(1);
		expect(r.passed).toBe(true);
	});

	it("a misattribution and a null (unresolved) both count as misses", () => {
		const r = scoreVoiceEntityMatch([
			match("owner-1", "owner-1"),
			match("guest-2", "owner-1"), // wrong entity
			match(null, "owner-1"), // unresolved
			match("owner-1", "owner-1"),
		]);
		expect(r.correct).toBe(2);
		expect(r.matchRate).toBe(0.5);
		expect(r.passed).toBe(false);
	});

	it("meets the default 0.9 gate at 9/10 correct", () => {
		const samples = [
			...Array.from({ length: 9 }, () => match("owner-1", "owner-1")),
			match("guest-2", "owner-1"),
		];
		const r = scoreVoiceEntityMatch(samples);
		expect(r.matchRate).toBe(0.9);
		expect(r.passed).toBe(true);
	});

	it("empty sample set fails closed", () => {
		const r = scoreVoiceEntityMatch([]);
		expect(r.total).toBe(0);
		expect(r.passed).toBe(false);
	});
});

describe("summarizeVoiceE2e over the respond/EOT/entity scorers (#9147)", () => {
	it("is passed only when every case passes", () => {
		const ok = summarizeVoiceE2e([
			scoreRespondDecision([respond(true, true), respond(false, false)]),
			scoreEotDecision([eot(true, true, 10), eot(false, false)]),
			scoreVoiceEntityMatch([match("a", "a")]),
		]);
		expect(ok.passed).toBe(true);
		expect(ok.cases).toHaveLength(3);
	});

	it("one failing case fails the whole summary", () => {
		const bad = summarizeVoiceE2e([
			scoreRespondDecision([respond(true, true), respond(false, false)]),
			scoreVoiceEntityMatch([match("a", "b")]), // miss → fails
		]);
		expect(bad.passed).toBe(false);
	});
});
