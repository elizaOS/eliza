/** Covers the composite end-of-turn classifier combining the fused scorer with heuristic signals. Deterministic. */
import { describe, expect, it, vi } from "vitest";
import { CompositeEotClassifier } from "./eot-classifier";
import type { FfiEotScorer } from "./fused-eot-scorer";

/** A stub fused scorer that returns a fixed model probability. */
function mockScorer(probability: number) {
	const score = vi.fn(async () => ({
		probability,
		latencyMs: 3,
		promptTokens: 5,
	}));
	const scorer = { modelLabel: "mock-eot", score } as unknown as FfiEotScorer;
	return { scorer, score };
}

describe("CompositeEotClassifier", () => {
	it("trusts the heuristic and skips the model when it is confident — sentence-final punctuation", async () => {
		const { scorer, score } = mockScorer(0.0);
		const c = new CompositeEotClassifier({ model: scorer });
		// "Hello there." → punctuation → heuristic 0.95 (confidence 0.9 ≥ cutoff).
		expect(await c.score("Hello there.")).toBeCloseTo(0.95, 5);
		expect(score).not.toHaveBeenCalled();
	});

	it("trusts the heuristic and skips the model when it is confident — trailing conjunction", async () => {
		const { scorer, score } = mockScorer(0.99);
		const c = new CompositeEotClassifier({ model: scorer });
		// "I want to go and" → trailing conjunction → heuristic 0.15 (confidence 0.7).
		expect(await c.score("I want to go and")).toBeCloseTo(0.15, 5);
		expect(score).not.toHaveBeenCalled();
	});

	it("defers to the model in the ambiguous middle (no syntactic signal)", async () => {
		const { scorer, score } = mockScorer(0.82);
		const c = new CompositeEotClassifier({ model: scorer });
		// 5 words, no punctuation, last word a pronoun → heuristic 0.5 (confidence
		// 0) → the blend is the pure model probability.
		expect(await c.score("tell me more about it")).toBeCloseTo(0.82, 5);
		expect(score).toHaveBeenCalledTimes(1);
	});

	it("blends model + heuristic for a mid-confidence heuristic (short utterance)", async () => {
		const { scorer, score } = mockScorer(0.2);
		const c = new CompositeEotClassifier({ model: scorer });
		// "okay sure" → 2 words → heuristic 0.7 (confidence 0.4 < cutoff) → model
		// runs; blend = 0.2·(1−0.4) + 0.7·0.4 = 0.40.
		expect(await c.score("okay sure")).toBeCloseTo(0.4, 5);
		expect(score).toHaveBeenCalledTimes(1);
	});

	it("signal() reports the model source only when the model contributed", async () => {
		const { scorer } = mockScorer(0.6);
		const c = new CompositeEotClassifier({ model: scorer });
		expect((await c.signal("Done.")).source).toBe("heuristic");
		const ambiguous = await c.signal("tell me more about it");
		expect(ambiguous.source).toBe("eliza-1-drafter");
		expect(ambiguous.model).toContain("mock-eot");
	});
});
