/**
 * Tests for prompt-optimization-trace — DPE optimization payloads.
 */
import { describe, expect, it } from "vitest";
import type {
	ExecutionTrace,
	ScoreSignal,
} from "./prompt-optimization-trace.ts";
import { DEFAULT_SIGNAL_WEIGHTS } from "./prompt-optimization-trace.ts";

describe("prompt-optimization-trace", () => {
	it("exports DEFAULT_SIGNAL_WEIGHTS with expected keys", () => {
		expect(DEFAULT_SIGNAL_WEIGHTS["dpe:parseSuccess"]).toBe(3.0);
		expect(DEFAULT_SIGNAL_WEIGHTS["dpe:schemaValid"]).toBe(2.0);
		expect(DEFAULT_SIGNAL_WEIGHTS["dpe:tokenEfficiency"]).toBe(0.5);
		expect(DEFAULT_SIGNAL_WEIGHTS["evaluator:*"]).toBe(1.5);
		expect(DEFAULT_SIGNAL_WEIGHTS["neuro:reaction_negative"]).toBe(1.5);
	});

	it("has 17 signal weights", () => {
		expect(Object.keys(DEFAULT_SIGNAL_WEIGHTS).length).toBe(17);
	});

	it("all weights are positive numbers", () => {
		for (const weight of Object.values(DEFAULT_SIGNAL_WEIGHTS)) {
			expect(typeof weight).toBe("number");
			expect(weight).toBeGreaterThan(0);
			expect(Number.isFinite(weight)).toBe(true);
		}
	});

	it("ScoreSignal type is compatible with expected shape", () => {
		const signal: ScoreSignal = {
			source: "test",
			kind: "dpe:parseSuccess",
			value: 1,
		};
		expect(signal.source).toBe("test");
	});

	it("ExecutionTrace type has required fields", () => {
		const trace: ExecutionTrace = {
			id: "trace-1",
			traceVersion: 1,
			type: "trace",
			promptKey: "key",
			modelSlot: "slot",
			modelId: "model",
			templateHash: "hash",
			schemaFingerprint: "fp",
			variant: "baseline",
			parseSuccess: true,
			schemaValid: true,
			validationCodesMatched: true,
			retriesUsed: 0,
			tokenEstimate: 100,
			latencyMs: 50,
			scoreCard: { signals: [], compositeScore: 0 },
			createdAt: Date.now(),
		};
		expect(trace.id).toBe("trace-1");
	});
});
