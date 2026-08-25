/**
 * Unit tests for `voice-prewarm`: verifies Eliza-1 model name matching,
 * concurrent prewarm request deduplication, engine warm-up pipeline execution,
 * and error suppression with state cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localInferenceEngine } from "./engine.ts";
import {
	prewarmLocalVoiceStackForModel,
	shouldPrewarmLocalVoiceStack,
} from "./voice-prewarm.ts";

vi.mock("./engine.ts", () => ({
	localInferenceEngine: {
		ensureActiveBundleAsrReady: vi.fn(),
		transcribePcm: vi.fn(),
		synthesizeSpeech: vi.fn(),
	},
}));

describe("voice-prewarm", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("shouldPrewarmLocalVoiceStack", () => {
		it.each([
			"eliza-1",
			"eliza-1-fast",
			"eliza-1-small",
			"eliza-1-7b-q4",
			"eliza-1-custom-bundle",
		])("returns true for Eliza-1 model identifier: %s", (modelId) => {
			expect(shouldPrewarmLocalVoiceStack(modelId)).toBe(true);
		});

		it.each([
			"",
			"eliza",
			"eliza-2",
			"eliza-10",
			"eliza1",
			"gpt-4o",
			"claude-3-5-sonnet",
			"whisper-base",
			"kokoro-v1",
		])("returns false for non-Eliza-1 model identifier: %s", (modelId) => {
			expect(shouldPrewarmLocalVoiceStack(modelId)).toBe(false);
		});
	});

	describe("prewarmLocalVoiceStackForModel", () => {
		it("returns false immediately and skips engine calls for non-Eliza-1 models", async () => {
			const result = await prewarmLocalVoiceStackForModel("gpt-4o");

			expect(result).toBe(false);
			expect(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).not.toHaveBeenCalled();
			expect(localInferenceEngine.transcribePcm).not.toHaveBeenCalled();
			expect(localInferenceEngine.synthesizeSpeech).not.toHaveBeenCalled();
		});

		it("runs ASR and TTS warm-up pipeline and returns true on success", async () => {
			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockResolvedValue(undefined as never);
			vi.mocked(localInferenceEngine.transcribePcm).mockResolvedValue({
				text: "hello",
			} as never);
			vi.mocked(localInferenceEngine.synthesizeSpeech).mockResolvedValue(
				new Uint8Array(100) as never,
			);

			const result = await prewarmLocalVoiceStackForModel("eliza-1");

			expect(result).toBe(true);
			expect(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).toHaveBeenCalledTimes(1);
			expect(localInferenceEngine.transcribePcm).toHaveBeenCalledWith({
				pcm: expect.any(Float32Array),
				sampleRate: 16_000,
			});
			expect(localInferenceEngine.synthesizeSpeech).toHaveBeenCalledWith(
				"Hello.",
			);
		});

		it("deduplicates concurrent prewarm calls for the same model and shares promise", async () => {
			let resolveAsr: () => void;
			const asrPromise = new Promise<void>((resolve) => {
				resolveAsr = resolve;
			});

			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockImplementation(() => asrPromise as never);
			vi.mocked(localInferenceEngine.transcribePcm).mockResolvedValue({
				text: "",
			} as never);
			vi.mocked(localInferenceEngine.synthesizeSpeech).mockResolvedValue(
				new Uint8Array(0) as never,
			);

			const p1 = prewarmLocalVoiceStackForModel("eliza-1-fast");
			const p2 = prewarmLocalVoiceStackForModel("eliza-1-fast");

			expect(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).toHaveBeenCalledTimes(1);

			resolveAsr?.();
			const [res1, res2] = await Promise.all([p1, p2]);

			expect(res1).toBe(true);
			expect(res2).toBe(true);

			// Subsequent call after resolution starts a new prewarm cycle
			const p3 = prewarmLocalVoiceStackForModel("eliza-1-fast");
			await p3;
			expect(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).toHaveBeenCalledTimes(2);
		});

		it("handles ASR preparation rejection gracefully without throwing", async () => {
			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockRejectedValue(new Error("ASR model load failed"));

			const result = await prewarmLocalVoiceStackForModel("eliza-1");

			expect(result).toBe(false);
			expect(localInferenceEngine.transcribePcm).not.toHaveBeenCalled();
			expect(localInferenceEngine.synthesizeSpeech).not.toHaveBeenCalled();
		});

		it("handles TTS synthesis rejection gracefully without throwing", async () => {
			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockResolvedValue(undefined as never);
			vi.mocked(localInferenceEngine.transcribePcm).mockResolvedValue({
				text: "",
			} as never);
			vi.mocked(localInferenceEngine.synthesizeSpeech).mockRejectedValue(
				new Error("TTS synth OOM"),
			);

			const result = await prewarmLocalVoiceStackForModel("eliza-1");

			expect(result).toBe(false);
		});

		it("resets active prewarm state on failure allowing future retries", async () => {
			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockRejectedValueOnce(new Error("Transient hardware lock"));

			const firstResult = await prewarmLocalVoiceStackForModel("eliza-1");
			expect(firstResult).toBe(false);

			vi.mocked(
				localInferenceEngine.ensureActiveBundleAsrReady,
			).mockResolvedValue(undefined as never);
			vi.mocked(localInferenceEngine.transcribePcm).mockResolvedValue({
				text: "ok",
			} as never);
			vi.mocked(localInferenceEngine.synthesizeSpeech).mockResolvedValue(
				new Uint8Array(50) as never,
			);

			const retryResult = await prewarmLocalVoiceStackForModel("eliza-1");
			expect(retryResult).toBe(true);
		});
	});
});
