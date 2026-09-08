/**
 * Text-tier fallback chains consulted by the runtime after a failover-class
 * model error: every text tier must end in a registration of another tier so a
 * two-bucket provider split has a cross-bucket candidate, and every chain
 * starts with the requested tier. Pure data contract; no runtime.
 */
import { describe, expect, it } from "vitest";
import { getModelFallbackChain, ModelType } from "./model";

describe("getModelFallbackChain", () => {
	it.each([
		ModelType.TEXT_NANO,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_LARGE,
		ModelType.TEXT_MEGA,
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
	])("%s starts with itself and reaches another tier", (modelType) => {
		const chain = getModelFallbackChain(modelType);
		expect(chain[0]).toBe(modelType);
		expect(chain.length).toBeGreaterThan(1);
		expect(new Set(chain).size).toBe(chain.length);
	});

	it("gives the small and large tiers a candidate in the other tier", () => {
		// Live 2026-09-05: a Cerebras split (small slots on one model, large on
		// another) left TEXT_SMALL and TEXT_LARGE with no chain, so a per-minute
		// 429 on either bucket hard-failed the call.
		expect(getModelFallbackChain(ModelType.TEXT_SMALL)).toContain(
			ModelType.TEXT_LARGE,
		);
		expect(getModelFallbackChain(ModelType.TEXT_LARGE)).toContain(
			ModelType.TEXT_SMALL,
		);
		expect(getModelFallbackChain(ModelType.RESPONSE_HANDLER)).toContain(
			ModelType.TEXT_LARGE,
		);
	});

	it("leaves non-text model types without a chain", () => {
		expect(getModelFallbackChain(ModelType.TEXT_EMBEDDING)).toEqual([
			ModelType.TEXT_EMBEDDING,
		]);
	});
});
