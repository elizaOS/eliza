/**
 * Smoke tests for `WespeakerEncoder` and `averageEmbeddings`.
 *
 * The encoder itself is an ONNX wrapper around the WeSpeaker ResNet34-LM
 * checkpoint. The actual `.onnx` file is shipped as an asset; CI does not
 * include the optional `onnxruntime-node` runtime, so the load path is
 * exercised via the structured `SpeakerEncoderUnavailableError`.
 *
 * The pure-function `averageEmbeddings` helper is fully covered here —
 * it sits at the heart of onboarding centroid construction.
 */

import { describe, expect, it } from "vitest";
import {
	averageEmbeddings,
	SpeakerEncoderUnavailableError,
	WESPEAKER_EMBEDDING_DIM,
	WESPEAKER_MIN_SAMPLES,
	WESPEAKER_RESNET34_LM_FP32_MODEL_ID,
	WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	WESPEAKER_SAMPLE_RATE,
	WespeakerEncoder,
} from "../src/services/voice/speaker/encoder";

describe("WespeakerEncoder — module constants", () => {
	it("declares 256-dim embedding output", () => {
		expect(WESPEAKER_EMBEDDING_DIM).toBe(256);
	});
	it("declares 16 kHz input sample rate", () => {
		expect(WESPEAKER_SAMPLE_RATE).toBe(16_000);
	});
	it("requires ≥ 1.0s of audio (16_000 samples)", () => {
		expect(WESPEAKER_MIN_SAMPLES).toBe(16_000);
	});
	it("declares stable int8 + fp32 model ids", () => {
		expect(WESPEAKER_RESNET34_LM_INT8_MODEL_ID).toBe("wespeaker-resnet34-lm-int8");
		expect(WESPEAKER_RESNET34_LM_FP32_MODEL_ID).toBe("wespeaker-resnet34-lm-fp32");
	});
});

describe("WespeakerEncoder.load — graceful failure", () => {
	it("returns a SpeakerEncoderUnavailableError when ORT or model is missing", async () => {
		// The bundled int8 model is not staged in CI, and onnxruntime-node
		// is an optional dep. Either failure is surfaced as the structured
		// error class (no hard crash).
		await expect(
			WespeakerEncoder.load("/nonexistent/path/wespeaker.onnx"),
		).rejects.toBeInstanceOf(SpeakerEncoderUnavailableError);
	});
});

describe("averageEmbeddings", () => {
	function unit(values: number[]): Float32Array {
		const out = new Float32Array(values.length);
		let sumSq = 0;
		for (const v of values) sumSq += v * v;
		const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
		for (let i = 0; i < values.length; i += 1) out[i] = values[i] * inv;
		return out;
	}

	it("returns a single L2-normalized centroid", () => {
		const out = averageEmbeddings([unit([1, 0, 0]), unit([0, 1, 0]), unit([0, 0, 1])]);
		let sumSq = 0;
		for (const v of out) sumSq += v * v;
		expect(sumSq).toBeCloseTo(1, 6);
		// Centroid should be uniformly close to ((1/√3)/√3) on each dim.
		expect(out[0]).toBeCloseTo(out[1], 6);
		expect(out[1]).toBeCloseTo(out[2], 6);
	});

	it("equals the single input when called with N=1", () => {
		const a = unit([1, 2, 3, 4]);
		const out = averageEmbeddings([a]);
		expect(Array.from(out)).toEqual(Array.from(a));
	});

	it("rejects empty input", () => {
		expect(() => averageEmbeddings([])).toThrow(SpeakerEncoderUnavailableError);
	});

	it("rejects dim-mismatched inputs", () => {
		expect(() =>
			averageEmbeddings([new Float32Array([1, 0, 0]), new Float32Array([1, 0])]),
		).toThrow(SpeakerEncoderUnavailableError);
	});

	it("centroid of near-identical samples is nearly identical to the prototype", () => {
		const proto = unit([1, 1, 1, 1, 1, 1, 1, 1]);
		const perturbed = [proto, unit([1.01, 0.99, 1, 1, 1, 1, 1, 1]), unit([0.99, 1.01, 1, 1, 1, 1, 1, 1])];
		const centroid = averageEmbeddings(perturbed);
		// Cosine similarity between the centroid and the prototype is ≈1.
		let dot = 0;
		for (let i = 0; i < centroid.length; i += 1) dot += centroid[i] * proto[i];
		expect(dot).toBeGreaterThan(0.999);
	});
});
