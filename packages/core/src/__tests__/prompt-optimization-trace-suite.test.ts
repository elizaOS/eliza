/**
 * Unit tests for prompt optimization trace structures and default signal weights.
 * Validates signal weight constants, categories, and execution trace shapes.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SIGNAL_WEIGHTS,
	type ExecutionTrace,
	type ScoreCardData,
	type ScoreSignal,
} from "../types/prompt-optimization-trace.ts";

describe("prompt-optimization-trace", () => {
	describe("DEFAULT_SIGNAL_WEIGHTS", () => {
		it("contains required DPE signal weights", () => {
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:parseSuccess"]).toBe(3.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:schemaValid"]).toBe(2.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:requiredFieldsPresent"]).toBe(2.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:validationCodesMatched"]).toBe(1.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:retriesUsed"]).toBe(1.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["dpe:tokenEfficiency"]).toBe(0.5);
		});

		it("contains evaluator and action signal weights", () => {
			expect(DEFAULT_SIGNAL_WEIGHTS["evaluator:*"]).toBe(1.5);
			expect(DEFAULT_SIGNAL_WEIGHTS["action:actionSuccess"]).toBe(2.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["action:actionFailure"]).toBe(2.0);
		});

		it("contains neuro signal weights", () => {
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:reaction_positive"]).toBe(1.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:reaction_negative"]).toBe(1.5);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:reaction_neutral"]).toBe(0.3);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:user_correction"]).toBe(2.0);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:conversation_continued"]).toBe(0.5);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:response_latency"]).toBe(0.3);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:length_appropriateness"]).toBe(0.3);
			expect(DEFAULT_SIGNAL_WEIGHTS["neuro:evaluator_agreement"]).toBe(1.0);
		});

		it("ensures all weights are positive numbers", () => {
			for (const [_key, weight] of Object.entries(DEFAULT_SIGNAL_WEIGHTS)) {
				expect(typeof weight).toBe("number");
				expect(weight).toBeGreaterThan(0);
				expect(Number.isFinite(weight)).toBe(true);
			}
		});
	});

	describe("ExecutionTrace shape and ScoreCardData", () => {
		it("validates a compliant execution trace object structure", () => {
			const signal: ScoreSignal = {
				source: "evaluator",
				kind: "action:actionSuccess",
				value: 1.0,
				weight: DEFAULT_SIGNAL_WEIGHTS["action:actionSuccess"],
				reason: "Action executed cleanly",
			};

			const scoreCard: ScoreCardData = {
				signals: [signal],
				compositeScore: 2.0,
			};

			const trace: ExecutionTrace = {
				id: "trace-001",
				traceVersion: 1,
				type: "trace",
				promptKey: "user-intent-classifier",
				modelSlot: "fast",
				modelId: "gpt-4o-mini",
				templateHash: "abc123hash",
				schemaFingerprint: "fingerprint-xyz",
				variant: "optimized",
				parseSuccess: true,
				schemaValid: true,
				validationCodesMatched: true,
				retriesUsed: 0,
				tokenEstimate: 150,
				latencyMs: 320,
				scoreCard,
				createdAt: 1700000000000,
			};

			expect(trace.type).toBe("trace");
			expect(trace.variant).toBe("optimized");
			expect(trace.scoreCard.signals).toHaveLength(1);
			expect(trace.scoreCard.compositeScore).toBe(2.0);
		});
	});
});
