/**
 * pyannote-segmentation-3.0 shared types and pure segmentation logic.
 *
 * Diarization runs EXCLUSIVELY through the fused `libelizainference`
 * `eliza_inference_diariz_*` ABI (`FusedDiarizer` in `diarizer-fused.ts`).
 * The standalone `libvoice_classifier` binding has been removed — there is one
 * on-device voice runtime.
 *
 * This file holds the shared types (`Diarizer`, `LocalSpeakerSegment`,
 * `DiarizerOutput`), the model-id / window constants, the structured
 * `DiarizerUnavailableError`, and the pure `classifyFramesToSegments` reducer
 * the fused diarizer feeds its per-frame labels through.
 */

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
	readonly code:
		| "ort-missing"
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-unavailable"
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
