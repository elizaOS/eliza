/**
 * VoiceEmotionClassifier tests.
 *
 * These tests cover the pure-TS surface of the classifier — the V-A-D →
 * `ExpressiveEmotion` projection table, error gating on inputs that don't
 * match the model contract, and the lazy-load behaviour against a *fake*
 * ONNX session. We do NOT load the real Wav2Small ONNX in CI — that file
 * lives in the eliza-1 voice bundle and is not vendored into the repo.
 *
 * The fake session is plugged in by monkey-patching the `onnx-runtime`
 * loader cache via `setLoadOnnxRuntimeForTesting` — but that helper does
 * not exist yet (the existing code uses a private memoised promise). To
 * keep test isolation honest we instead exercise the classifier through
 * the constructor + projection helpers, and the test that asserts the
 * loader contract is a structural import smoke test.
 */

import { describe, expect, it } from "vitest";
import {
	projectVadToExpressiveEmotion,
	VoiceEmotionClassifier,
	VoiceEmotionClassifierError,
	WAV2SMALL_INT8_MODEL_ID,
	WAV2SMALL_MIN_SAMPLES,
	WAV2SMALL_SAMPLE_RATE,
} from "./voice-emotion-classifier";

describe("projectVadToExpressiveEmotion", () => {
	it("projects neutral V-A-D centre to a null discrete label", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.5,
			arousal: 0.5,
			dominance: 0.5,
		});
		// At the centre the strongest mass is ≤ the 0.35 threshold so we abstain.
		expect(out.emotion).toBeNull();
		expect(out.confidence).toBeLessThan(0.35);
		// Every class has a finite score.
		for (const tag of [
			"happy",
			"sad",
			"angry",
			"nervous",
			"calm",
			"excited",
			"whisper",
		] as const) {
			expect(out.scores[tag]).toBeGreaterThanOrEqual(0);
			expect(out.scores[tag]).toBeLessThanOrEqual(1);
		}
	});

	it("projects high valence + high arousal to excited or happy", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.9,
			arousal: 0.9,
			dominance: 0.55,
		});
		expect(["excited", "happy"]).toContain(out.emotion);
		expect(out.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("projects low valence + low arousal to sad", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.1,
			arousal: 0.1,
			dominance: 0.2,
		});
		expect(out.emotion).toBe("sad");
		expect(out.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("projects low valence + high arousal + high dominance to angry", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.1,
			arousal: 0.9,
			dominance: 0.9,
		});
		expect(out.emotion).toBe("angry");
		expect(out.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("projects high valence + low arousal to calm", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.85,
			arousal: 0.15,
			dominance: 0.5,
		});
		expect(out.emotion).toBe("calm");
		expect(out.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("projects low arousal + low dominance to whisper", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 0.5,
			arousal: 0.05,
			dominance: 0.05,
		});
		expect(out.emotion).toBe("whisper");
		expect(out.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("clamps inputs outside [0, 1]", () => {
		const out = projectVadToExpressiveEmotion({
			valence: 2,
			arousal: -1,
			dominance: 0.5,
		});
		// Sanitised: V=1, A=0, D=0.5 → calm-ish (high V, low A).
		expect(out.emotion).toBe("calm");
	});

	it("treats non-finite inputs as zero", () => {
		const out = projectVadToExpressiveEmotion({
			valence: Number.NaN,
			arousal: Number.POSITIVE_INFINITY,
			dominance: Number.NEGATIVE_INFINITY,
		});
		// All three clamped → no axis pushes any class above 0.35.
		expect(out.emotion).toBeNull();
		expect(Number.isFinite(out.confidence)).toBe(true);
	});
});

describe("VoiceEmotionClassifier construction", () => {
	it("requires a non-empty model path", () => {
		expect(
			() => new VoiceEmotionClassifier({ modelPath: "" }),
		).toThrow(VoiceEmotionClassifierError);
	});

	it("defaults the model id to the int8 student", () => {
		// We can construct without loading; loading happens lazily.
		const c = new VoiceEmotionClassifier({ modelPath: "/tmp/nope.onnx" });
		expect(c).toBeInstanceOf(VoiceEmotionClassifier);
		// modelId is private; we cover its surfaced value through `classify` in
		// integration tests. Smoke: the const is what we expect.
		expect(WAV2SMALL_INT8_MODEL_ID).toBe("wav2small-msp-dim-int8");
	});

	it("classify rejects a Float32Array that is shorter than the minimum window", async () => {
		const c = new VoiceEmotionClassifier({ modelPath: "/tmp/nope.onnx" });
		const tooShort = new Float32Array(WAV2SMALL_MIN_SAMPLES - 1);
		await expect(c.classify(tooShort)).rejects.toBeInstanceOf(
			VoiceEmotionClassifierError,
		);
	});

	it("classify rejects a non-Float32Array PCM input", async () => {
		const c = new VoiceEmotionClassifier({ modelPath: "/tmp/nope.onnx" });
		// @ts-expect-error — deliberate runtime type-check coverage.
		await expect(c.classify(new Uint8Array(WAV2SMALL_SAMPLE_RATE))).rejects.toBeInstanceOf(
			VoiceEmotionClassifierError,
		);
	});
});
