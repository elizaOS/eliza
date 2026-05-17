/**
 * Smoke tests for the pyannote-segmentation-3.0 ONNX diarizer.
 *
 * The encoder itself needs the actual model file + onnxruntime-node; CI
 * doesn't have either. So this suite covers:
 *  - the constants matching the upstream model card,
 *  - the pure `classifyFramesToSegments` function (the hot path of the
 *    diarizer that turns raw class-logits into segments),
 *  - structured failure when the model can't load,
 *  - the powerset class table matches the pyannote-3 head spec.
 */

import { describe, expect, it } from "vitest";
import {
	classifyFramesToSegments,
	DiarizerUnavailableError,
	PYANNOTE_CLASS_COUNT,
	PYANNOTE_CLASS_TO_SPEAKERS,
	PYANNOTE_FRAME_STRIDE_MS,
	PYANNOTE_FRAMES_PER_WINDOW,
	PYANNOTE_SAMPLE_RATE,
	PYANNOTE_SEGMENTATION_3_FP32_MODEL_ID,
	PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
	PYANNOTE_WINDOW_SECONDS,
	PyannoteDiarizer,
} from "../src/services/voice/speaker/diarizer";

describe("Pyannote diarizer — module constants", () => {
	it("uses a 5-second window at 16 kHz", () => {
		expect(PYANNOTE_WINDOW_SECONDS).toBe(5);
		expect(PYANNOTE_SAMPLE_RATE).toBe(16_000);
	});
	it("emits 293 frames per window (powerset head)", () => {
		expect(PYANNOTE_FRAMES_PER_WINDOW).toBe(293);
	});
	it("frame stride is ≈ 17 ms", () => {
		expect(PYANNOTE_FRAME_STRIDE_MS).toBeCloseTo(17.06, 1);
	});
	it("declares 7 output classes (1 silence + 3 single + 3 overlap)", () => {
		expect(PYANNOTE_CLASS_COUNT).toBe(7);
		expect(PYANNOTE_CLASS_TO_SPEAKERS).toHaveLength(7);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[0]).toEqual([]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[1]).toEqual([0]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[2]).toEqual([1]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[3]).toEqual([2]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[4]).toEqual([0, 1]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[5]).toEqual([0, 2]);
		expect(PYANNOTE_CLASS_TO_SPEAKERS[6]).toEqual([1, 2]);
	});
	it("declares stable int8 + fp32 model ids", () => {
		expect(PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID).toBe("pyannote-segmentation-3.0-int8");
		expect(PYANNOTE_SEGMENTATION_3_FP32_MODEL_ID).toBe("pyannote-segmentation-3.0-fp32");
	});
});

describe("PyannoteDiarizer.load — graceful failure", () => {
	it("raises DiarizerUnavailableError when the model file can't be loaded", async () => {
		await expect(
			PyannoteDiarizer.load("/nonexistent/path/pyannote.onnx"),
		).rejects.toBeInstanceOf(DiarizerUnavailableError);
	});
});

// ---------------------------------------------------------------------------
// Pure-function: classifyFramesToSegments
// ---------------------------------------------------------------------------

function buildClassProbs(framesByClass: number[]): Float32Array {
	// Build a `[frames, 7]` flat array where the winning class for each
	// frame is given by `framesByClass[f]` (logit 5, others 0).
	const frames = framesByClass.length;
	const out = new Float32Array(frames * PYANNOTE_CLASS_COUNT);
	for (let f = 0; f < frames; f += 1) {
		const winner = framesByClass[f];
		out[f * PYANNOTE_CLASS_COUNT + winner] = 5;
	}
	return out;
}

describe("classifyFramesToSegments — golden cases", () => {
	it("single speaker for the whole window", () => {
		// Five frames, all class=1 (speaker 0 only).
		const probs = buildClassProbs([1, 1, 1, 1, 1]);
		const out = classifyFramesToSegments(probs, 5, PYANNOTE_CLASS_COUNT, 0, 100);
		expect(out.localSpeakerCount).toBe(1);
		expect(out.segments).toHaveLength(1);
		expect(out.segments[0].localSpeakerId).toBe(0);
		expect(out.segments[0].startMs).toBe(0);
		expect(out.segments[0].endMs).toBe(500);
		expect(out.segments[0].hasOverlap).toBe(false);
		expect(out.speechMs).toBe(500);
	});

	it("two speakers, sequential — emits two non-overlapping segments", () => {
		// 4 frames speaker 0 (class=1), then 4 frames speaker 1 (class=2).
		const probs = buildClassProbs([1, 1, 1, 1, 2, 2, 2, 2]);
		const out = classifyFramesToSegments(probs, 8, PYANNOTE_CLASS_COUNT, 0, 100);
		expect(out.localSpeakerCount).toBe(2);
		expect(out.segments).toHaveLength(2);
		expect(out.segments[0]).toMatchObject({
			localSpeakerId: 0,
			startMs: 0,
			endMs: 400,
			hasOverlap: false,
		});
		expect(out.segments[1]).toMatchObject({
			localSpeakerId: 1,
			startMs: 400,
			endMs: 800,
			hasOverlap: false,
		});
	});

	it("silence frames don't contribute to any segment", () => {
		// class 0 = silence.
		const probs = buildClassProbs([1, 1, 0, 0, 0, 2, 2]);
		const out = classifyFramesToSegments(probs, 7, PYANNOTE_CLASS_COUNT, 0, 100);
		expect(out.localSpeakerCount).toBe(2);
		// Two segments: speaker 0 (0..200), speaker 1 (500..700).
		expect(out.segments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ localSpeakerId: 0, startMs: 0, endMs: 200 }),
				expect.objectContaining({ localSpeakerId: 1, startMs: 500, endMs: 700 }),
			]),
		);
		expect(out.speechMs).toBe(400);
	});

	it("overlap class flags hasOverlap and emits one segment per speaker", () => {
		// Two frames class=4 (speakers 0+1 overlap), then one frame class=2 (speaker 1).
		const probs = buildClassProbs([4, 4, 2]);
		const out = classifyFramesToSegments(probs, 3, PYANNOTE_CLASS_COUNT, 0, 100);
		expect(out.localSpeakerCount).toBe(2);
		// Speaker 0's segment is the two overlap frames.
		const sp0 = out.segments.find((s) => s.localSpeakerId === 0);
		expect(sp0).toMatchObject({ startMs: 0, endMs: 200, hasOverlap: true });
		// Speaker 1's segment spans frames 0..3 because they're active in
		// all three (overlap then solo).
		const sp1 = out.segments.find((s) => s.localSpeakerId === 1);
		expect(sp1).toMatchObject({ startMs: 0, endMs: 300, hasOverlap: true });
	});

	it("threading the startMs offset into the segment times", () => {
		const probs = buildClassProbs([1, 1, 1]);
		const out = classifyFramesToSegments(probs, 3, PYANNOTE_CLASS_COUNT, 1500, 100);
		expect(out.segments[0].startMs).toBe(1500);
		expect(out.segments[0].endMs).toBe(1800);
	});

	it("throws on frame×class mismatch", () => {
		const probs = new Float32Array(10);
		expect(() => classifyFramesToSegments(probs, 3, PYANNOTE_CLASS_COUNT, 0, 100)).toThrow(
			DiarizerUnavailableError,
		);
	});

	it("empty input yields zero segments", () => {
		const probs = new Float32Array(0);
		const out = classifyFramesToSegments(probs, 0, PYANNOTE_CLASS_COUNT, 0, 100);
		expect(out.segments).toEqual([]);
		expect(out.localSpeakerCount).toBe(0);
		expect(out.speechMs).toBe(0);
	});
});
