/**
 * Deterministic unit tests for `decideRLMUse` — the pure RLM routing gate that
 * chooses between the recursive-language-model loop and a direct one-shot model
 * call; no model, DB, or runtime.
 */
import { describe, expect, it } from "vitest";
import { decideRLMUse } from "./rlm.ts";

describe("decideRLMUse", () => {
	it("enables when explicitly requested, overriding every other signal", () => {
		expect(decideRLMUse({ explicitlyRequested: true })).toEqual({
			enabled: true,
			reason: "explicitly_requested",
			budget: { maxIterations: 4, maxDepth: 1, maxLatencyMs: undefined },
		});
	});

	it("explicit request wins even for a short task kind with tiny context", () => {
		const decision = decideRLMUse({
			taskKind: "bfcl",
			contextTokens: 10,
			contextChars: 10,
			explicitlyRequested: true,
		});
		expect(decision.enabled).toBe(true);
		expect(decision.reason).toBe("explicitly_requested");
	});

	it("carries the latency budget into every decision", () => {
		const withBudget = decideRLMUse({
			taskKind: "bfcl",
			latencyBudgetMs: 5000,
		});
		expect(withBudget.budget.maxLatencyMs).toBe(5000);

		const withoutBudget = decideRLMUse({ taskKind: "bfcl" });
		expect(withoutBudget.budget.maxLatencyMs).toBeUndefined();
	});

	it("disables each known short task kind", () => {
		const shortKinds = [
			"action-calling",
			"bfcl",
			"mind2web",
			"vending_bench",
			"voicebench",
			"woobench",
		];
		for (const taskKind of shortKinds) {
			const decision = decideRLMUse({ taskKind });
			expect(decision.enabled, taskKind).toBe(false);
			expect(decision.reason, taskKind).toBe("short_action_task");
			expect(decision.budget).toEqual({
				maxIterations: 4,
				maxDepth: 1,
				maxLatencyMs: undefined,
			});
		}
	});

	it("normalizes task kind by trimming whitespace and lowercasing", () => {
		const decision = decideRLMUse({ taskKind: "  VoiceBench  " });
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("short_action_task");
	});

	it("treats an empty or whitespace-only task kind as absent", () => {
		for (const taskKind of ["", "   "]) {
			const decision = decideRLMUse({
				taskKind,
				contextTokens: 0,
				contextChars: 0,
			});
			expect(decision.enabled, JSON.stringify(taskKind)).toBe(false);
			expect(decision.reason, JSON.stringify(taskKind)).toBe(
				"context_within_direct_model_budget",
			);
		}
	});

	it("falls through to context sizing for an unknown task kind", () => {
		const small = decideRLMUse({
			taskKind: "longform-research",
			contextTokens: 1000,
			contextChars: 5000,
		});
		expect(small.enabled).toBe(false);
		expect(small.reason).toBe("context_within_direct_model_budget");
	});

	it("defaults missing context sizes to zero and stays within the direct budget", () => {
		const decision = decideRLMUse({});
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("context_within_direct_model_budget");
	});

	it("keeps contexts under both thresholds on the direct path", () => {
		const decision = decideRLMUse({
			contextTokens: 31_999,
			contextChars: 127_999,
		});
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("context_within_direct_model_budget");
	});

	it("routes token-threshold boundary sizes to RLM without external context", () => {
		const atTokenLimit = decideRLMUse({
			contextTokens: 32_000,
			contextChars: 0,
		});
		expect(atTokenLimit.enabled).toBe(true);
		expect(atTokenLimit.reason).toBe("large_external_context");

		const justBelow = decideRLMUse({
			contextTokens: 31_999,
			contextChars: 0,
		});
		expect(justBelow.enabled).toBe(false);
		expect(justBelow.reason).toBe("context_within_direct_model_budget");
	});

	it("routes character-threshold boundary sizes to RLM without external context", () => {
		const atCharLimit = decideRLMUse({
			contextTokens: 0,
			contextChars: 128_000,
		});
		expect(atCharLimit.enabled).toBe(true);
		expect(atCharLimit.reason).toBe("large_external_context");

		const justBelow = decideRLMUse({
			contextTokens: 0,
			contextChars: 127_999,
		});
		expect(justBelow.enabled).toBe(false);
		expect(justBelow.reason).toBe("context_within_direct_model_budget");
	});

	it("external context alone engages RLM regardless of measured size", () => {
		const decision = decideRLMUse({
			hasExternalContext: true,
			contextTokens: 0,
			contextChars: 0,
		});
		expect(decision.enabled).toBe(true);
		expect(decision.reason).toBe("large_external_context");
	});
});
