/**
 * pyannote-segmentation-3.0 ONNX local diarizer wrapper.
 *
 * `pyannote/segmentation-3.0` is a 3-second-window local segmenter that
 * outputs a `[batch=1, frames=293, classes=7]` logit tensor: three
 * single-speaker activity classes, three two-speaker-overlap classes,
 * and silence. The upstream model card maps the seven classes to
 * powerset activity over the local 3-speaker codebook. We translate the
 * classwise activity into a sequence of `LocalSpeakerSegment` rows with
 * `startMs / endMs / localSpeakerId` and let the
 * `VoiceProfileStore` cluster *across* segments (the model only assigns
 * **local** speaker indices, not stable identities).
 *
 * The diarizer runs *after* Silero VAD opens a speech window — it
 * subdivides the window into per-speaker spans. It is NOT a VAD
 * replacement (Silero is faster and cheaper for the low-latency mic
 * gate); pyannote's silence class is only used to refine the boundaries
 * Silero already produced.
 *
 * License: MIT (onnx-community/pyannote-segmentation-3.0). Attribution
 * still recorded in `models/voice/manifest.json` per the policy.
 */

import {
	loadOnnxRuntime,
	OnnxRuntimeUnavailableError,
	type OrtInferenceSession,
	type OrtTensorCtor,
} from "../onnx-runtime";

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
 * silence/no-speaker frame. This matches the upstream `Powerset` head
 * with `max_speakers_per_chunk=3, max_speakers_per_frame=2`.
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
	readonly code: "ort-missing" | "model-load-failed" | "invalid-input";
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
	/** Best class confidence over the span (max softmax). */
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
	/** Process one ~5 s window of PCM. */
	diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput>;
	dispose(): Promise<void>;
}

async function loadOrt() {
	try {
		return await loadOnnxRuntime();
	} catch (err) {
		if (err instanceof OnnxRuntimeUnavailableError) {
			throw new DiarizerUnavailableError(
				"ort-missing",
				`${err.message} Install it to enable on-device diarization; the pipeline treats every speech window as a single speaker without it.`,
			);
		}
		throw err;
	}
}

/** Numerically-stable softmax over the last axis. */
function softmax(row: Float32Array): Float32Array {
	let max = -Infinity;
	for (let i = 0; i < row.length; i += 1) {
		if (row[i] > max) max = row[i];
	}
	const out = new Float32Array(row.length);
	let sum = 0;
	for (let i = 0; i < row.length; i += 1) {
		out[i] = Math.exp(row[i] - max);
		sum += out[i];
	}
	if (sum === 0) return out;
	for (let i = 0; i < row.length; i += 1) out[i] /= sum;
	return out;
}

/**
 * Reduce a per-frame class probability tensor into one segment per
 * (local speaker × contiguous frame run). Frames where the silence
 * class wins are excluded; frames in overlap classes contribute to
 * **all** speakers in that class.
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
	type Active = {
		startFrame: number;
		endFrame: number;
		confSum: number;
		count: number;
		hasOverlap: boolean;
	};
	// Per-speaker active runs. The pyannote-3 head supports 3 speakers.
	const open = new Map<number, Active>();
	const closed: Array<Active & { speakerId: number }> = [];

	let speechFrames = 0;

	for (let f = 0; f < frames; f += 1) {
		const offset = f * classCount;
		const row = classProbs.subarray(offset, offset + classCount);
		const probs = softmax(row);
		// Pick winning class.
		let winner = 0;
		let winnerProb = probs[0];
		for (let c = 1; c < classCount; c += 1) {
			if (probs[c] > winnerProb) {
				winner = c;
				winnerProb = probs[c];
			}
		}
		const activeSpeakers = PYANNOTE_CLASS_TO_SPEAKERS[winner] ?? [];
		const isOverlap = activeSpeakers.length > 1;
		if (activeSpeakers.length > 0) speechFrames += 1;

		// Close runs for speakers not active this frame.
		for (const [sid, run] of open.entries()) {
			if (!activeSpeakers.includes(sid)) {
				closed.push({ ...run, speakerId: sid });
				open.delete(sid);
			}
		}
		// Open / extend runs for active speakers.
		for (const sid of activeSpeakers) {
			const existing = open.get(sid);
			if (existing) {
				existing.endFrame = f + 1;
				existing.confSum += winnerProb;
				existing.count += 1;
				existing.hasOverlap = existing.hasOverlap || isOverlap;
			} else {
				open.set(sid, {
					startFrame: f,
					endFrame: f + 1,
					confSum: winnerProb,
					count: 1,
					hasOverlap: isOverlap,
				});
			}
		}
	}
	// Flush remaining open runs.
	for (const [sid, run] of open.entries()) {
		closed.push({ ...run, speakerId: sid });
	}

	const segments = closed
		.map<LocalSpeakerSegment>((run) => ({
			startMs: Math.round(startMs + run.startFrame * frameStrideMs),
			endMs: Math.round(startMs + run.endFrame * frameStrideMs),
			localSpeakerId: run.speakerId,
			confidence: run.count > 0 ? run.confSum / run.count : 0,
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
 * pyannote-segmentation-3.0 ONNX diarizer. Expects mono 16 kHz PCM and
 * processes one window at a time. Multi-window inputs (longer than 5 s)
 * are the caller's responsibility — the `VoicePipeline` slides 5 s
 * windows with 0.5 s overlap and merges adjacent same-speaker segments.
 */
export class PyannoteDiarizer implements Diarizer {
	readonly modelId: PyannoteDiarizerModelId;
	readonly sampleRate = PYANNOTE_SAMPLE_RATE;
	private disposed = false;

	private constructor(
		private readonly session: OrtInferenceSession,
		private readonly Tensor: OrtTensorCtor,
		private readonly inputName: string,
		private readonly outputName: string,
		modelId: PyannoteDiarizerModelId,
	) {
		this.modelId = modelId;
	}

	static async load(
		modelPath: string,
		modelId: PyannoteDiarizerModelId = PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
	): Promise<PyannoteDiarizer> {
		const ort = await loadOrt();
		let session: OrtInferenceSession;
		try {
			session = await ort.InferenceSession.create(modelPath);
		} catch (err) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				`[pyannote] failed to load diarizer from ${modelPath}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		const inputName = session.inputNames[0];
		const outputName = session.outputNames[0];
		if (!inputName || !outputName) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[pyannote] ONNX session is missing input/output bindings",
			);
		}
		return new PyannoteDiarizer(
			session,
			ort.Tensor,
			inputName,
			outputName,
			modelId,
		);
	}

	async diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput> {
		if (this.disposed) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[pyannote] diarizer has been disposed",
			);
		}
		const expected = PYANNOTE_SAMPLE_RATE * PYANNOTE_WINDOW_SECONDS;
		if (pcm.length === 0) {
			return { segments: [], localSpeakerCount: 0, speechMs: 0 };
		}
		// Pad / truncate to one 5 s window. The pyannote ONNX graph
		// expects a fixed-shape input; the caller has to slide windows
		// itself for anything longer than 5 s.
		const window =
			pcm.length === expected
				? pcm
				: (() => {
						const out = new Float32Array(expected);
						out.set(pcm.subarray(0, Math.min(pcm.length, expected)));
						return out;
					})();
		const input = new this.Tensor("float32", window, [1, 1, window.length]);
		const out = await this.session.run({ [this.inputName]: input });
		const tensor = out[this.outputName];
		if (!tensor || !(tensor.data instanceof Float32Array)) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[pyannote] diarizer did not return a Float32Array output",
			);
		}
		const total = tensor.data.length;
		// The graph emits `[1, frames, classes]`; we don't trust the dims
		// from the manifest because some exports squeeze the batch.
		const frames = total / PYANNOTE_CLASS_COUNT;
		if (!Number.isInteger(frames) || frames < 1) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				`[pyannote] expected total a multiple of ${PYANNOTE_CLASS_COUNT}, got ${total}`,
			);
		}
		const frameStrideMs = (1_000 * PYANNOTE_WINDOW_SECONDS) / frames;
		return classifyFramesToSegments(
			tensor.data as Float32Array,
			frames,
			PYANNOTE_CLASS_COUNT,
			0,
			frameStrideMs,
		);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const maybe = this.session as unknown as {
			release?: () => Promise<void> | void;
		};
		if (typeof maybe.release === "function") {
			await maybe.release();
		}
	}
}
