import { describe, expect, it, vi } from "vitest";
import { localInferenceEngine } from "../src/services/engine.ts";
import {
	filterUnavailableLocalInference,
	filterUnavailableLocalInferenceCandidates,
} from "../src/services/router-handler.ts";

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

describe("filterUnavailableLocalInference (slot-aware)", () => {
	const local = reg("eliza-local-inference", 0);
	const cloud = reg("elizacloud", 50);

	it("bypasses the availability gate for TEXT_TO_SPEECH (voice handlers self-load)", async () => {
		const candidates = [cloud, local];
		const result = await filterUnavailableLocalInference(
			"TEXT_TO_SPEECH",
			"prefer-local",
			null,
			candidates,
		);
		expect(result).toEqual(candidates);
	});

	it("gates TRANSCRIPTION on local ASR availability (#9652)", async () => {
		const candidates = [cloud, local];
		const spy = vi.spyOn(localInferenceEngine, "canTranscribeLocally");
		// #9652: TRANSCRIPTION no longer bypasses the availability gate — without an
		// eligible Gemma ASR bundle the local candidate is filtered out, like any
		// other slot.
		spy.mockResolvedValue(false);
		expect(
			await filterUnavailableLocalInference(
				"TRANSCRIPTION",
				"prefer-local",
				null,
				candidates,
			),
		).toEqual([cloud]);
		// With local ASR available, the local candidate is kept.
		spy.mockResolvedValue(true);
		expect(
			await filterUnavailableLocalInference(
				"TRANSCRIPTION",
				"prefer-local",
				null,
				candidates,
			),
		).toEqual(candidates);
		spy.mockRestore();
	});

	it("returns text-slot candidates unchanged when none are local-inference", async () => {
		const nonLocal = [cloud, reg("openai", 100)];
		const result = await filterUnavailableLocalInference(
			"TEXT_SMALL",
			"prefer-local",
			null,
			nonLocal,
		);
		expect(result).toEqual(nonLocal);
	});
});
