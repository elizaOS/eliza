/**
 * Unit tests for RLM policy decision gate: validates budget allocation,
 * task kind gating, token/char thresholds, and explicit request overrides.
 */
import { describe, expect, it } from "vitest";
import { decideRLMUse } from "./rlm.ts";

describe("rlm policy", () => {
	it("enables RLM when explicitly requested regardless of task kind or size", () => {
		const decision = decideRLMUse({
			taskKind: "action-calling",
			contextTokens: 100,
			explicitlyRequested: true,
			latencyBudgetMs: 5000,
		});
		expect(decision.enabled).toBe(true);
		expect(decision.reason).toBe("explicitly_requested");
		expect(decision.budget.maxLatencyMs).toBe(5000);
	});

	it("disables RLM for known short action task kinds", () => {
		const kinds = [
			"action-calling",
			"bfcl",
			"mind2web",
			"vending_bench",
			"voicebench",
			"woobench",
		];
		for (const kind of kinds) {
			const decision = decideRLMUse({ taskKind: kind });
			expect(decision.enabled).toBe(false);
			expect(decision.reason).toBe("short_action_task");
		}
	});

	it("disables RLM when context is within direct model budget and not external", () => {
		const decision = decideRLMUse({
			taskKind: "general-reasoning",
			contextTokens: 10000,
			contextChars: 40000,
			hasExternalContext: false,
		});
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("context_within_direct_model_budget");
	});

	it("enables RLM when external context is present", () => {
		const decision = decideRLMUse({
			taskKind: "general-reasoning",
			contextTokens: 500,
			hasExternalContext: true,
		});
		expect(decision.enabled).toBe(true);
		expect(decision.reason).toBe("large_external_context");
	});

	it("enables RLM when context exceeds token or character thresholds", () => {
		const tokenDecision = decideRLMUse({
			contextTokens: 35000,
			contextChars: 50000,
		});
		expect(tokenDecision.enabled).toBe(true);
		expect(tokenDecision.reason).toBe("large_external_context");

		const charDecision = decideRLMUse({
			contextTokens: 20000,
			contextChars: 150000,
		});
		expect(charDecision.enabled).toBe(true);
		expect(charDecision.reason).toBe("large_external_context");
	});
});
