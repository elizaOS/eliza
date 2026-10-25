/** Covers voice-workbench scoring wiring (EOT / respond / diarization) over the scenario matrix. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	scoreDiarization,
	scoreEntityExtraction,
	scoreEotDecision,
	scoreRespondDecision,
	scoreVoiceEntityMatch,
	summarizeVoiceE2e,
} from "./e2e-harness";
import { type VoiceScenario, validateVoiceScenario } from "./voice-scenario";

describe("scoreEotDecision", () => {
	it("computes false-trigger / false-suppression + latency percentiles", () => {
		const r = scoreEotDecision([
			{ decided: true, expected: true, latencyMs: 100 },
			{ decided: true, expected: false }, // false trigger
			{ decided: false, expected: true }, // false suppression
			{ decided: false, expected: false },
		]);
		expect(r.total).toBe(4);
		expect(r.falseTriggerRate).toBe(0.25);
		expect(r.falseSuppressionRate).toBe(0.25);
		expect(r.accuracy).toBe(0.5);
		expect(r.latencyP50Ms).toBe(100);
		// 1 false trigger / 4 = 0.25 > default 0.1 → fail.
		expect(r.passed).toBe(false);
	});
});

describe("scoreRespondDecision", () => {
	it("separates false-positive (talked over) from false-negative (stayed silent)", () => {
		const r = scoreRespondDecision([
			{ responded: true, expectRespond: true },
			{ responded: false, expectRespond: false },
			{ responded: true, expectRespond: false }, // FP
			{ responded: false, expectRespond: true }, // FN
		]);
		expect(r.accuracy).toBe(0.5);
		expect(r.falsePositiveRate).toBe(0.5); // 1 of 2 shouldn't-respond
		expect(r.falseNegativeRate).toBe(0.5); // 1 of 2 should-respond
		expect(r.passed).toBe(false);
	});
	it("passes a clean run", () => {
		const r = scoreRespondDecision([
			{ responded: true, expectRespond: true },
			{ responded: false, expectRespond: false },
		]);
		expect(r.accuracy).toBe(1);
		expect(r.passed).toBe(true);
	});
});

describe("scoreDiarization", () => {
	it("counts confusions + misses into DER", () => {
		const r = scoreDiarization([
			{ predictedLabel: "alice", expectedLabel: "alice" },
			{ predictedLabel: "bob", expectedLabel: "alice" }, // confusion
			{ predictedLabel: null, expectedLabel: "bob" }, // miss
			{ predictedLabel: "bob", expectedLabel: "bob" },
		]);
		expect(r.confusions).toBe(1);
		expect(r.misses).toBe(1);
		expect(r.der).toBe(0.5);
		expect(r.passed).toBe(false);
	});
});

describe("scoreEntityExtraction", () => {
	it("computes precision/recall/F1 (case-insensitive)", () => {
		const r = scoreEntityExtraction({
			expected: ["Jill", "Bob"],
			inferred: ["jill", "carol"],
		});
		expect(r.precision).toBe(0.5);
		expect(r.recall).toBe(0.5);
		expect(r.f1).toBe(0.5);
		expect(r.passed).toBe(false);
	});
	it("perfect match passes", () => {
		const r = scoreEntityExtraction({
			expected: ["Jill"],
			inferred: ["Jill"],
		});
		expect(r.f1).toBe(1);
		expect(r.passed).toBe(true);
	});
});

describe("scoreVoiceEntityMatch", () => {
	it("scores recognized-voice → entity binding accuracy", () => {
		const r = scoreVoiceEntityMatch([
			{ matchedEntityId: "e1", expectedEntityId: "e1" },
			{ matchedEntityId: "e2", expectedEntityId: "e1" },
			{ matchedEntityId: null, expectedEntityId: "e3" },
		]);
		expect(r.correct).toBe(1);
		expect(r.matchRate).toBeCloseTo(0.3333, 3);
		expect(r.passed).toBe(false);
	});
});

describe("summarizeVoiceE2e includes the new case kinds", () => {
	it("rolls up mixed scorer results", () => {
		const summary = summarizeVoiceE2e([
			scoreRespondDecision([{ responded: true, expectRespond: true }]),
			scoreDiarization([{ predictedLabel: "a", expectedLabel: "a" }]),
		]);
		expect(summary.passed).toBe(true);
		expect(summary.cases).toHaveLength(2);
	});
});

describe("validateVoiceScenario", () => {
	const base: VoiceScenario = {
		id: "respond-no-respond-basic",
		classes: ["respond-no-respond", "multi-speaker"],
		participants: [
			{ label: "alice", entityId: "e-alice" },
			{ label: "eliza", isOwner: false },
		],
		turns: [
			{ speaker: "alice", text: "Eliza what's the time?", expectRespond: true },
			{ speaker: "alice", text: "bob, pass the salt", expectRespond: false },
		],
	};

	it("accepts a well-formed scenario", () => {
		expect(validateVoiceScenario(base).valid).toBe(true);
	});

	it("flags unknown speakers, missing audio/text, and bad agents", () => {
		const bad: VoiceScenario = {
			...base,
			turns: [
				{ speaker: "ghost", expectRespond: true }, // unknown speaker + no text
			],
			agents: ["nope"],
		};
		const result = validateVoiceScenario(bad);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
		expect(result.errors.some((e) => e.includes("text or audioRef"))).toBe(
			true,
		);
		expect(result.errors.some((e) => e.includes('agent "nope"'))).toBe(true);
	});

	it("requires id, classes, participants, and turns", () => {
		const empty = validateVoiceScenario({
			id: "",
			classes: [],
			participants: [],
			turns: [],
		} as VoiceScenario);
		expect(empty.valid).toBe(false);
		expect(empty.errors.length).toBeGreaterThanOrEqual(4);
	});
});
