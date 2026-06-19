/**
 * Pure-function tests for voice-emotion-classifier.ts.
 *
 * Covers the V-A-D → `ExpressiveEmotion` projection table and the 7-class
 * logit interpreter. The ONNX-backed `VoiceEmotionClassifier` class was
 * removed when `onnxruntime-node` was dropped; only these pure projection
 * helpers remain.
 */

import { describe, expect, it } from "vitest";
import {
	interpretCls7Output,
	projectVadToExpressiveEmotion,
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

describe("interpretCls7Output (cls7 head)", () => {
	it("picks the argmax class with calibrated softmax confidence", () => {
		// Logits aligned with EXPRESSIVE_EMOTION_TAGS:
		//   ["happy","sad","angry","nervous","calm","excited","whisper"]
		const logits = new Float32Array([0, 0, 5, 0, 0, 0, 0]); // strong angry
		const out = interpretCls7Output(logits, WAV2SMALL_INT8_MODEL_ID, 7);
		expect(out.emotion).toBe("angry");
		expect(out.confidence).toBeGreaterThan(0.9);
		// All 7 score keys present, all probabilities in [0, 1], sum ≈ 1.
		const tags = [
			"happy",
			"sad",
			"angry",
			"nervous",
			"calm",
			"excited",
			"whisper",
		] as const;
		let total = 0;
		for (const tag of tags) {
			expect(out.scores[tag]).toBeGreaterThanOrEqual(0);
			expect(out.scores[tag]).toBeLessThanOrEqual(1);
			total += out.scores[tag];
		}
		expect(total).toBeGreaterThan(0.999);
		expect(total).toBeLessThan(1.001);
		// V-A-D is the neutral midpoint for cls7 (no V-A-D head).
		expect(out.vad.valence).toBeCloseTo(0.5, 5);
		expect(out.vad.arousal).toBeCloseTo(0.5, 5);
		expect(out.vad.dominance).toBeCloseTo(0.5, 5);
		expect(out.modelId).toBe(WAV2SMALL_INT8_MODEL_ID);
		expect(out.latencyMs).toBe(7);
	});

	it("equal logits return a near-uniform distribution", () => {
		const logits = new Float32Array([1, 1, 1, 1, 1, 1, 1]);
		const out = interpretCls7Output(logits, WAV2SMALL_INT8_MODEL_ID, 0);
		// First-index wins on ties (happy at index 0).
		expect(out.emotion).toBe("happy");
		// Uniform distribution gives every class probability ≈ 1/7.
		expect(out.confidence).toBeCloseTo(1 / 7, 5);
	});

	it("falls back to abstain when all logits are non-finite", () => {
		const logits = new Float32Array([
			Number.NaN,
			Number.NaN,
			Number.NaN,
			Number.NaN,
			Number.NaN,
			Number.NaN,
			Number.NaN,
		]);
		const out = interpretCls7Output(logits, WAV2SMALL_INT8_MODEL_ID, 0);
		expect(out.emotion).toBeNull();
		expect(out.confidence).toBe(0);
	});

	it("rejects logit arrays of the wrong length", () => {
		const wrong = new Float32Array([0, 0, 0]); // V-A-D-sized
		expect(() =>
			interpretCls7Output(wrong, WAV2SMALL_INT8_MODEL_ID, 0),
		).toThrow(VoiceEmotionClassifierError);
	});

	it("respects the EXPRESSIVE_EMOTION_TAGS class order", () => {
		// Pick the highest logit at each index and confirm we get that tag back.
		const order = [
			"happy",
			"sad",
			"angry",
			"nervous",
			"calm",
			"excited",
			"whisper",
		] as const;
		for (let i = 0; i < order.length; i++) {
			const logits = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
			logits[i] = 5;
			const out = interpretCls7Output(logits, WAV2SMALL_INT8_MODEL_ID, 0);
			expect(out.emotion).toBe(order[i]);
		}
	});
});

describe("model id constants", () => {
	it("WAV2SMALL_INT8_MODEL_ID is the expected stable string", () => {
		expect(WAV2SMALL_INT8_MODEL_ID).toBe("wav2small-msp-dim-int8");
	});

	it("WAV2SMALL_MIN_SAMPLES is at least one second at 16 kHz", () => {
		expect(WAV2SMALL_MIN_SAMPLES).toBeGreaterThanOrEqual(WAV2SMALL_SAMPLE_RATE);
	});
});
