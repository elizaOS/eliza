/**
 * Deterministic coverage for the umbrella planner-budget decision in the
 * message service: the dispatch threshold is an upper-bound estimate, so the
 * smallest complete surface is dispatched even when it misses that estimate.
 * Pure function under test; no runtime, model, or database.
 */
import { describe, expect, it } from "vitest";
import { decideUmbrellaPlannerBudget } from "./message";

describe("decideUmbrellaPlannerBudget", () => {
	it("accepts an umbrella that fits the dispatch estimate", () => {
		expect(
			decideUmbrellaPlannerBudget({
				umbrella: {
					estimatedInputTokens: 90_000,
					dispatchThresholdTokens: 104_857,
				},
				current: { estimatedInputTokens: 506_107 },
			}),
		).toBe("under-dispatch-budget");
	});

	it("dispatches the umbrella above the estimate when it is smaller than the current complete surface", () => {
		// Live shape: 155-tool surface estimated at 506,107 (provider counted
		// 190,732 and rejected it); 29-parent umbrella estimated at 143,224.
		expect(
			decideUmbrellaPlannerBudget({
				umbrella: {
					estimatedInputTokens: 143_224,
					dispatchThresholdTokens: 104_857,
				},
				current: { estimatedInputTokens: 506_107 },
			}),
		).toBe("smaller-than-complete-surface");
	});

	it("keeps the current request when the umbrella is not smaller", () => {
		expect(
			decideUmbrellaPlannerBudget({
				umbrella: {
					estimatedInputTokens: 143_224,
					dispatchThresholdTokens: 104_857,
				},
				current: { estimatedInputTokens: 143_224 },
			}),
		).toBe("not-smaller");
		expect(
			decideUmbrellaPlannerBudget({
				umbrella: {
					estimatedInputTokens: 150_000,
					dispatchThresholdTokens: 104_857,
				},
				current: { estimatedInputTokens: 143_224 },
			}),
		).toBe("not-smaller");
	});
});
