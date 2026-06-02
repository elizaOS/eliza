import { describe, expect, it } from "vitest";
import { filterUnavailableLocalInferenceCandidates } from "../src/services/router-handler.ts";

/**
 * Factory for a minimal {@link HandlerRegistration}-shaped object.
 * The router only inspects `provider`; the handler is a no-op.
 */
function reg(provider: string, priority = 0) {
	return {
		modelType: "TEXT_SMALL" as const,
		provider,
		priority,
		registeredAt: "test",
		handler: (() => {}) as never,
	};
}

describe("filterUnavailableLocalInferenceCandidates", () => {
	const local = reg("eliza-local-inference", 0);
	const cloud = reg("elizacloud", 50);
	const candidates = [cloud, local];

	it("keeps all candidates when local inference is available", () => {
		const result = filterUnavailableLocalInferenceCandidates(
			candidates,
			/* localInferenceAvailable */ true,
			/* forceLocalInference */ false,
		);
		expect(result).toEqual(candidates);
	});

	it("keeps all candidates when force-local is true", () => {
		const result = filterUnavailableLocalInferenceCandidates(
			candidates,
			/* localInferenceAvailable */ false,
			/* forceLocalInference */ true,
		);
		expect(result).toEqual(candidates);
	});

	it("filters out local-inference candidates when unavailable and not forced", () => {
		const result = filterUnavailableLocalInferenceCandidates(
			candidates,
			/* localInferenceAvailable */ false,
			/* forceLocalInference */ false,
		);
		expect(result).toEqual([cloud]);
		expect(result.find((c) => c.provider === "eliza-local-inference")).toBeUndefined();
	});

	it("returns all candidates unchanged when none are local-inference", () => {
		const nonLocal = [cloud, reg("openai", 100)];
		const result = filterUnavailableLocalInferenceCandidates(
			nonLocal,
			/* localInferenceAvailable */ false,
			/* forceLocalInference */ false,
		);
		expect(result).toEqual(nonLocal);
	});
});
