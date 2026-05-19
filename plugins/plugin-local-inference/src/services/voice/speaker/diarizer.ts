/**
 * pyannote-segmentation-3.0 GGML/GGUF local diarizer.
 *
 * Loads `pyannote-segmentation-3.0.gguf` (produced by
 * `packages/native/plugins/voice-classifier-cpp/scripts/voice_diarizer_to_gguf.py`)
 * through the `voice-classifier-cpp` SHARED library via `bun:ffi` and
 * runs the full SincNet + BiLSTM + 7-class powerset head natively. The
 * per-frame powerset labels are translated into a sequence of
 * `LocalSpeakerSegment` rows with `startMs / endMs / localSpeakerId`;
 * the `VoiceProfileStore` clusters speakers *across* segments (the
 * model only assigns **local** speaker indices, not stable identities).
 *
 * The diarizer runs *after* Silero VAD opens a speech window — it
 * subdivides the window into per-speaker spans. It is NOT a VAD
 * replacement (Silero is faster and cheaper for the low-latency mic
 * gate); pyannote's silence class is only used to refine the
 * boundaries Silero already produced.
 *
 * License: MIT (the segmentation-3.0 checkpoint itself; the wider
 * pyannote toolkit is CC-BY-NC). Attribution recorded in
 * `models/voice/manifest.json`.
 */

import { DiarizerGgml, DiarizerGgmlUnavailableError } from "./diarizer-ggml";

export const PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID =
	"pyannote-segmentation-3.0-int8" as const;
export const PYANNOTE_SEGMENTATION_3_FP32_MODEL_ID =
	"pyannote-segmentation-3.0-fp32" as const;
export type PyannoteDiarizerModelId =
	| typeof PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID
	| typeof PYANNOTE_SEGMENTATION_3_FP32_MODEL_ID;

/** pyannote 3.0 segmentation window length (seconds) — model-fixed. */
export const PYANNOTE_WINDOW_SECONDS = 5;
/** Required mono sample rate (matches upstream training config). */
export const PYANNOTE_SAMPLE_RATE = 16_000;
/** Number of output frames per 5 s window (= 293 in the upstream export). */
export const PYANNOTE_FRAMES_PER_WINDOW = 293;
/** Per-frame stride in milliseconds (5_000ms / 293 frames ≈ 17.06 ms). */
export const PYANNOTE_FRAME_STRIDE_MS =
	(1_000 * PYANNOTE_WINDOW_SECONDS) / PYANNOTE_FRAMES_PER_WINDOW;
/** Output class count — 3 single + 3 overlap + 1 silence = 7. */
export const PYANNOTE_CLASS_COUNT = 7;

/**
 * Powerset mapping of pyannote-3 segmentation classes. Each class is
 * the set of local speaker indices active in that frame. Class 0 is the
 * silence/no-speaker frame.
 */
export const PYANNOTE_CLASS_TO_SPEAKERS: ReadonlyArray<ReadonlyArray<number>> =
	[
		[], // 0: silence
		[0], // 1: speaker 0 only
		[1], // 2: speaker 1 only
		[2], // 3: speaker 2 only
		[0, 1], // 4: speakers 0+1 overlap
		[0, 2], // 5: speakers 0+2 overlap
		[1, 2], // 6: speakers 1+2 overlap
	];

/** Thrown when the diarizer cannot be constructed. */
export class DiarizerUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-load-failed"
		| "model-shape-mismatch"
		| "forward-not-implemented"
		| "invalid-input";
	constructor(code: DiarizerUnavailableError["code"], message: string) {
		super(message);
		this.name = "DiarizerUnavailableError";
		this.code = code;
	}
}

/**
 * One speaker-tagged span within a diarized window. `localSpeakerId` is
 * **window-local** (0..2): the same physical speaker gets different
 * local ids in different windows. The profile store re-clusters local
 * ids into stable identities via the WeSpeaker embedding cosine.
 */
export interface LocalSpeakerSegment {
	startMs: number;
	endMs: number;
	localSpeakerId: number;
	/** Per-frame confidence over the span. Always 1 in the ggml path —
	 *  the native graph returns argmax labels, not softmax probabilities.
	 *  The ONNX path used the max softmax; downstream consumers should
	 *  treat this as a presence flag and not a calibrated probability. */
	confidence: number;
	/** True if the span contains any overlap-class frames. */
	hasOverlap: boolean;
}

export interface DiarizerOutput {
	segments: LocalSpeakerSegment[];
	/** Number of distinct local speakers observed in the window. */
	localSpeakerCount: number;
	/** Total speech (any-speaker) duration in milliseconds. */
	speechMs: number;
}

export interface Diarizer {
	readonly modelId: PyannoteDiarizerModelId;
	readonly sampleRate: number;
	diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput>;
	dispose(): Promise<void>;
}

/**
 * Reduce a per-frame powerset-label tensor into one segment per
 * (local speaker × contiguous frame run). Frames in overlap classes
 * contribute to *all* speakers in that class.
 */
export function labelsToSegments(
	labels: Int8Array,
	startMs: number,
	frameStrideMs: number,
): DiarizerOutput {
	const frames = labels.length;
	type Active = {
		startFrame: number;
		endFrame: number;
		count: number;
		hasOverlap: boolean;
	};
	const open = new Map<number, Active>();
	const closed: Array<Active & { speakerId: number }> = [];
	let speechFrames = 0;

	for (let f = 0; f < frames; f += 1) {
		const cls = labels[f];
		if (cls < 0 || cls >= PYANNOTE_CLASS_TO_SPEAKERS.length) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				`[pyannote] frame ${f} carries out-of-range class ${cls}`,
			);
		}
		const activeSpeakers = PYANNOTE_CLASS_TO_SPEAKERS[cls] ?? [];
		const isOverlap = activeSpeakers.length > 1;
		if (activeSpeakers.length > 0) speechFrames += 1;

		for (const [sid, run] of open.entries()) {
			if (!activeSpeakers.includes(sid)) {
				closed.push({ ...run, speakerId: sid });
				open.delete(sid);
			}
		}
		for (const sid of activeSpeakers) {
			const existing = open.get(sid);
			if (existing) {
				existing.endFrame = f + 1;
				existing.count += 1;
				existing.hasOverlap = existing.hasOverlap || isOverlap;
			} else {
				open.set(sid, {
					startFrame: f,
					endFrame: f + 1,
					count: 1,
					hasOverlap: isOverlap,
				});
			}
		}
	}
	for (const [sid, run] of open.entries()) {
		closed.push({ ...run, speakerId: sid });
	}

	const segments = closed
		.map<LocalSpeakerSegment>((run) => ({
			startMs: Math.round(startMs + run.startFrame * frameStrideMs),
			endMs: Math.round(startMs + run.endFrame * frameStrideMs),
			localSpeakerId: run.speakerId,
			confidence: 1,
			hasOverlap: run.hasOverlap,
		}))
		.sort((a, b) =>
			a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
		);

	const localSpeakers = new Set(segments.map((s) => s.localSpeakerId));
	return {
		segments,
		localSpeakerCount: localSpeakers.size,
		speechMs: Math.round(speechFrames * frameStrideMs),
	};
}

/**
 * Back-compat helper for callers that still produce raw per-frame
 * class probabilities (e.g. tests). Picks the argmax per frame, then
 * delegates to `labelsToSegments`.
 */
export function classifyFramesToSegments(
	classProbs: Float32Array,
	frames: number,
	classCount: number,
	startMs: number,
	frameStrideMs: number,
): DiarizerOutput {
	if (classProbs.length !== frames * classCount) {
		throw new DiarizerUnavailableError(
			"model-load-failed",
			`[pyannote] frame×class tensor mismatch: have ${classProbs.length}, expected ${frames * classCount}`,
		);
	}
	const labels = new Int8Array(frames);
	for (let f = 0; f < frames; f += 1) {
		const offset = f * classCount;
		let best = 0;
		let bestVal = classProbs[offset];
		for (let c = 1; c < classCount; c += 1) {
			const v = classProbs[offset + c];
			if (v > bestVal) {
				bestVal = v;
				best = c;
			}
		}
		labels[f] = best;
	}
	return labelsToSegments(labels, startMs, frameStrideMs);
}

function translateError(err: unknown): DiarizerUnavailableError | Error {
	if (err instanceof DiarizerGgmlUnavailableError) {
		return new DiarizerUnavailableError(err.code, err.message);
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * pyannote-segmentation-3.0 GGML diarizer. Wraps `DiarizerGgml` so the
 * rest of the pipeline keeps importing `PyannoteDiarizer` by name.
 */
export class PyannoteDiarizer implements Diarizer {
	readonly modelId: PyannoteDiarizerModelId;
	readonly sampleRate = PYANNOTE_SAMPLE_RATE;
	private disposed = false;

	private constructor(
		private readonly inner: DiarizerGgml,
		modelId: PyannoteDiarizerModelId,
	) {
		this.modelId = modelId;
	}

	static async load(
		modelPath: string,
		modelId: PyannoteDiarizerModelId = PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
	): Promise<PyannoteDiarizer> {
		let inner: DiarizerGgml;
		try {
			inner = new DiarizerGgml({ ggufPath: modelPath });
		} catch (err) {
			throw translateError(err);
		}
		return new PyannoteDiarizer(inner, modelId);
	}

	async diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput> {
		if (this.disposed) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[pyannote] diarizer has been disposed",
			);
		}
		if (pcm.length === 0) {
			return { segments: [], localSpeakerCount: 0, speechMs: 0 };
		}
		try {
			const out = await this.inner.segment(pcm);
			const frames = out.labels.length;
			const frameStrideMs =
				frames > 0 ? (1_000 * PYANNOTE_WINDOW_SECONDS) / frames : 0;
			return labelsToSegments(out.labels, 0, frameStrideMs);
		} catch (err) {
			throw translateError(err);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.inner.dispose();
	}
}
