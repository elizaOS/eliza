import { beforeEach, describe, expect, it, vi } from "vitest";

const { localInferenceEngine } = vi.hoisted(() => ({
	localInferenceEngine: {
		ensureActiveBundleAsrReady: vi.fn(async () => {}),
		transcribePcm: vi.fn(async () => ({ text: "" })),
		synthesizeSpeech: vi.fn(async () => new Uint8Array(0)),
	},
}));

vi.mock("./engine", () => ({ localInferenceEngine }));

import {
	prewarmLocalVoiceStackForModel,
	shouldPrewarmLocalVoiceStack,
} from "./voice-prewarm";

describe("shouldPrewarmLocalVoiceStack", () => {
	it("returns true only for eliza-1 bundle ids", () => {
		expect(shouldPrewarmLocalVoiceStack("eliza-1")).toBe(true);
		expect(shouldPrewarmLocalVoiceStack("eliza-1-nano")).toBe(true);
		expect(shouldPrewarmLocalVoiceStack("eliza-1-small")).toBe(true);
	});

	it("returns false for other model ids", () => {
		expect(shouldPrewarmLocalVoiceStack("eliza-2")).toBe(false);
		expect(shouldPrewarmLocalVoiceStack("eliza-10")).toBe(false);
		expect(shouldPrewarmLocalVoiceStack("eliza-1.5")).toBe(false);
		expect(shouldPrewarmLocalVoiceStack("kokoro")).toBe(false);
		expect(shouldPrewarmLocalVoiceStack("")).toBe(false);
	});
});

describe("prewarmLocalVoiceStackForModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does nothing for non-eliza-1 models and returns false", async () => {
		await expect(prewarmLocalVoiceStackForModel("kokoro")).resolves.toBe(false);
		expect(
			localInferenceEngine.ensureActiveBundleAsrReady,
		).not.toHaveBeenCalled();
		expect(localInferenceEngine.transcribePcm).not.toHaveBeenCalled();
		expect(localInferenceEngine.synthesizeSpeech).not.toHaveBeenCalled();
	});

	it("runs a warmup pass for an eliza-1 model and returns true", async () => {
		await expect(prewarmLocalVoiceStackForModel("eliza-1")).resolves.toBe(true);
		expect(
			localInferenceEngine.ensureActiveBundleAsrReady,
		).toHaveBeenCalledTimes(1);
		expect(localInferenceEngine.transcribePcm).toHaveBeenCalledTimes(1);
		expect(localInferenceEngine.synthesizeSpeech).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent prewarms for the same model id", async () => {
		const [a, b] = await Promise.all([
			prewarmLocalVoiceStackForModel("eliza-1"),
			prewarmLocalVoiceStackForModel("eliza-1"),
		]);
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(
			localInferenceEngine.ensureActiveBundleAsrReady,
		).toHaveBeenCalledTimes(1);
		expect(localInferenceEngine.synthesizeSpeech).toHaveBeenCalledTimes(1);
	});

	it("does not dedupe different model ids", async () => {
		await Promise.all([
			prewarmLocalVoiceStackForModel("eliza-1"),
			prewarmLocalVoiceStackForModel("eliza-1-nano"),
		]);
		expect(
			localInferenceEngine.ensureActiveBundleAsrReady,
		).toHaveBeenCalledTimes(2);
	});

	it("returns false and swallows engine failures", async () => {
		localInferenceEngine.ensureActiveBundleAsrReady.mockRejectedValueOnce(
			new Error("model load failed"),
		);
		await expect(prewarmLocalVoiceStackForModel("eliza-1")).resolves.toBe(
			false,
		);
		expect(localInferenceEngine.transcribePcm).not.toHaveBeenCalled();
	});

	it("allows a fresh prewarm after the previous one settled", async () => {
		await prewarmLocalVoiceStackForModel("eliza-1");
		await prewarmLocalVoiceStackForModel("eliza-1");
		expect(
			localInferenceEngine.ensureActiveBundleAsrReady,
		).toHaveBeenCalledTimes(2);
	});
});
