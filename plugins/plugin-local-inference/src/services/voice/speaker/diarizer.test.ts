import { describe, expect, it } from "vitest";
import {
	classifyFramesToSegments,
	DiarizerUnavailableError,
	PYANNOTE_CLASS_COUNT,
	PYANNOTE_CLASS_TO_SPEAKERS,
	PYANNOTE_FRAME_STRIDE_MS,
} from "./diarizer";

/** One-hot row: class c = 1.0, everything else ~0. */
function oneHot(rowCount: number, c: number): Float32Array {
	const row = new Float32Array(rowCount);
	row[c] = 1;
	return row;
}

/** Stack rows into a frames×classCount tensor. */
function tensor(rows: Float32Array[]): Float32Array {
	const out = new Float32Array(rows.length * rows[0].length);
	for (let f = 0; f < rows.length; f += 1) {
		out.set(rows[f], f * rows[0].length);
	}
	return out;
}

describe("classifyFramesToSegments shape guard", () => {
	it("throws model-load-failed on tensor length mismatch", () => {
		expect(() =>
			classifyFramesToSegments(
				new Float32Array(10),
				3,
				PYANNOTE_CLASS_COUNT,
				0,
				PYANNOTE_FRAME_STRIDE_MS,
			),
		).toThrow(DiarizerUnavailableError);
		try {
			classifyFramesToSegments(
				new Float32Array(10),
				3,
				PYANNOTE_CLASS_COUNT,
				0,
				PYANNOTE_FRAME_STRIDE_MS,
			);
		} catch (e) {
			expect((e as DiarizerUnavailableError).code).toBe("model-load-failed");
		}
	});

	it("throws model-shape-mismatch when the model emits a class outside the known powerset", () => {
		// A wrong ONNX export with an extra class makes the winner index land
		// beyond PYANNOTE_CLASS_TO_SPEAKERS; those frames used to be silently
		// classified as silence, dropping an entire speaker's audio.
		const classCount = PYANNOTE_CLASS_COUNT + 1;
		const frames = tensor([oneHot(classCount, 7), oneHot(classCount, 0)]);
		expect(() =>
			classifyFramesToSegments(
				frames,
				2,
				classCount,
				0,
				PYANNOTE_FRAME_STRIDE_MS,
			),
		).toThrow(DiarizerUnavailableError);
		try {
			classifyFramesToSegments(
				frames,
				2,
				classCount,
				0,
				PYANNOTE_FRAME_STRIDE_MS,
			);
		} catch (e) {
			expect((e as DiarizerUnavailableError).code).toBe("model-shape-mismatch");
		}
	});
});

describe("classifyFramesToSegments segmentation", () => {
	it("produces no segments and zero speechMs when silence wins every frame", () => {
		const frames = tensor([
			oneHot(PYANNOTE_CLASS_COUNT, 0),
			oneHot(PYANNOTE_CLASS_COUNT, 0),
		]);
		const out = classifyFramesToSegments(
			frames,
			2,
			PYANNOTE_CLASS_COUNT,
			1000,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		expect(out.segments).toHaveLength(0);
		expect(out.localSpeakerCount).toBe(0);
		expect(out.speechMs).toBe(0);
	});

	it("builds one segment for a single-speaker run with confidence and times", () => {
		const frames = tensor([
			oneHot(PYANNOTE_CLASS_COUNT, 1),
			oneHot(PYANNOTE_CLASS_COUNT, 1),
		]);
		const out = classifyFramesToSegments(
			frames,
			2,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		expect(out.segments).toHaveLength(1);
		const seg = out.segments[0];
		expect(seg.localSpeakerId).toBe(0);
		expect(seg.startMs).toBe(0);
		expect(seg.endMs).toBe(Math.round(2 * PYANNOTE_FRAME_STRIDE_MS));
		// softmax over 7 classes with a 1.0 winner (float32 arithmetic)
		expect(seg.confidence).toBeCloseTo(
			Math.E / (Math.E + PYANNOTE_CLASS_COUNT - 1),
			6,
		);
		expect(seg.hasOverlap).toBe(false);
		expect(out.localSpeakerCount).toBe(1);
		expect(out.speechMs).toBe(Math.round(2 * PYANNOTE_FRAME_STRIDE_MS));
	});

	it("splits into separate segments when the speaker switches", () => {
		const frames = tensor([
			oneHot(PYANNOTE_CLASS_COUNT, 1),
			oneHot(PYANNOTE_CLASS_COUNT, 1),
			oneHot(PYANNOTE_CLASS_COUNT, 2),
			oneHot(PYANNOTE_CLASS_COUNT, 2),
		]);
		const out = classifyFramesToSegments(
			frames,
			4,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		expect(out.segments).toHaveLength(2);
		expect(out.segments[0].localSpeakerId).toBe(0);
		expect(out.segments[1].localSpeakerId).toBe(1);
		expect(out.localSpeakerCount).toBe(2);
	});

	it("marks overlap frames on the owning segment", () => {
		const frames = tensor([oneHot(PYANNOTE_CLASS_COUNT, 4)]); // speakers 0+1
		const out = classifyFramesToSegments(
			frames,
			1,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		expect(out.segments).toHaveLength(2);
		for (const seg of out.segments) {
			expect(seg.hasOverlap).toBe(true);
		}
	});

	it("merges a speaker's interrupted runs into separate segments", () => {
		const frames = tensor([
			oneHot(PYANNOTE_CLASS_COUNT, 1),
			oneHot(PYANNOTE_CLASS_COUNT, 0),
			oneHot(PYANNOTE_CLASS_COUNT, 1),
		]);
		const out = classifyFramesToSegments(
			frames,
			3,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		expect(out.segments).toHaveLength(2);
		expect(out.segments[0].startMs).toBe(0);
		expect(out.segments[1].startMs).toBe(
			Math.round(2 * PYANNOTE_FRAME_STRIDE_MS),
		);
	});

	it("averages confidence across the run", () => {
		const rowA = new Float32Array(PYANNOTE_CLASS_COUNT);
		rowA[1] = 0.8;
		rowA[0] = 0.2;
		const rowB = new Float32Array(PYANNOTE_CLASS_COUNT);
		rowB[1] = 0.6;
		rowB[0] = 0.4;
		const frames = tensor([rowA, rowB]);
		const out = classifyFramesToSegments(
			frames,
			2,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
		// softmax(rowA)[1] = e^0.8 / (e^0.8 + e^0.2 + 5); softmax(rowB)[1] = e^0.6 / (e^0.6 + e^0.4 + 5)
		const softmaxA = Math.exp(0.8) / (Math.exp(0.8) + Math.exp(0.2) + 5);
		const softmaxB = Math.exp(0.6) / (Math.exp(0.6) + Math.exp(0.4) + 5);
		expect(out.segments[0].confidence).toBeCloseTo(
			(softmaxA + softmaxB) / 2,
			6,
		);
	});
});
