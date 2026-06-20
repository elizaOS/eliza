/**
 * pyannote-segmentation-3.0 diarizer — fused `libelizainference` binding
 * (ABI v6).
 *
 * Drives the native pyannote diarizer through the single fused-FFI
 * `libelizainference` handle (the merged llama.cpp fork — see
 * `plugins/plugin-local-inference/native/CLAUDE.md` §1) via the
 * `eliza_inference_diariz_*` ABI. This is the SOLE on-device diarizer runtime —
 * the same `ffi`/`ctx` pair powers VAD / wake-word / speaker / TTS / ASR.
 *
 * The native call returns a per-frame powerset-label sequence (293 int8
 * labels per 5 s window, each in `[0, 7)`). Agglomerative clustering and the
 * frame→segment reduction stay JS-side: this class one-hots the labels and
 * feeds them through the shared pure `classifyFramesToSegments` reducer.
 *
 * No silent fallback: when the fused build does not export the diarizer ABI
 * (`eliza_inference_diariz_supported() == 0`) `load()` throws a structured
 * `DiarizerUnavailableError` (AGENTS.md §3 — never fabricate a label
 * sequence, no standalone-lib fallback).
 */

import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeDiarizHandle,
} from "../ffi-bindings";
import {
	classifyFramesToSegments,
	type Diarizer,
	type DiarizerOutput,
	DiarizerUnavailableError,
	PYANNOTE_CLASS_COUNT,
	PYANNOTE_FRAME_STRIDE_MS,
	PYANNOTE_SAMPLE_RATE,
	PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
	type PyannoteDiarizerModelId,
} from "./diarizer";

export interface FusedDiarizerOptions {
	ffi: ElizaInferenceFfi;
	ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
	/**
	 * Optional explicit pyannote GGUF path. `null` lets the native runtime
	 * resolve the bundle's `diariz/` dir (the default).
	 */
	ggufPath?: string | null;
	/** Stored model id (purely informational). */
	modelId?: PyannoteDiarizerModelId;
}

/**
 * Fused-`libelizainference` pyannote-3 diarizer. Owns one
 * `eliza_inference_diariz_*` session; `diarizeWindow()` runs one forward pass
 * over a ~5 s window and reduces the powerset labels into speaker segments.
 */
export class FusedDiarizer implements Diarizer {
	readonly sampleRate = PYANNOTE_SAMPLE_RATE;
	readonly modelId: PyannoteDiarizerModelId;
	private disposed = false;

	private constructor(
		private readonly ffi: ElizaInferenceFfi,
		private readonly handle: NativeDiarizHandle,
		modelId: PyannoteDiarizerModelId,
	) {
		this.modelId = modelId;
	}

	/**
	 * True only when the fused `libelizainference` build exports the diarizer
	 * ABI and advertises support at runtime.
	 */
	static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
		if (!ffi || typeof ffi.diarizSupported !== "function") return false;
		return ffi.diarizSupported();
	}

	/**
	 * Open a native diarizer session. Throws `DiarizerUnavailableError` when
	 * the runtime is not present.
	 */
	static async load(opts: FusedDiarizerOptions): Promise<FusedDiarizer> {
		if (!FusedDiarizer.isSupported(opts.ffi)) {
			throw new DiarizerUnavailableError(
				"native-missing",
				"[diarizer-fused] The native diarizer is not present in this libelizainference build. Rebuild with the pyannote forward graph linked in (eliza_inference_diariz_* symbols).",
			);
		}
		if (
			!opts.ffi.diarizOpen ||
			!opts.ffi.diarizSegment ||
			!opts.ffi.diarizClose
		) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[diarizer-fused] Diarizer support probe succeeded, but the required FFI methods are missing on the binding.",
			);
		}
		const ctx = typeof opts.ctx === "function" ? opts.ctx() : opts.ctx;
		const handle = opts.ffi.diarizOpen({
			ctx,
			ggufPath: opts.ggufPath ?? null,
		});
		return new FusedDiarizer(
			opts.ffi,
			handle,
			opts.modelId ?? PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
		);
	}

	async diarizeWindow(pcm: Float32Array): Promise<DiarizerOutput> {
		if (this.disposed) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[diarizer-fused] diarizeWindow called after dispose()",
			);
		}
		const segment = this.ffi.diarizSegment;
		if (!segment) {
			throw new DiarizerUnavailableError(
				"model-load-failed",
				"[diarizer-fused] diarizeWindow missing FFI method",
			);
		}
		const labels = segment({ diariz: this.handle, pcm });
		const frames = labels.length;
		// One-hot the powerset labels into the frame×class tensor the shared
		// pure reducer expects (it argmaxes back out, so the one-hot is exact).
		const probs = new Float32Array(frames * PYANNOTE_CLASS_COUNT);
		for (let frame = 0; frame < frames; frame += 1) {
			const label = labels[frame] ?? -1;
			if (label < 0 || label >= PYANNOTE_CLASS_COUNT) {
				throw new DiarizerUnavailableError(
					"model-load-failed",
					`[diarizer-fused] native diarizer emitted invalid class ${label} at frame ${frame}`,
				);
			}
			probs[frame * PYANNOTE_CLASS_COUNT + label] = 1;
		}
		return classifyFramesToSegments(
			probs,
			frames,
			PYANNOTE_CLASS_COUNT,
			0,
			PYANNOTE_FRAME_STRIDE_MS,
		);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.ffi.diarizClose?.(this.handle);
	}
}
