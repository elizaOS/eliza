/**
 * Speaker-embedding encoder — fused `libelizainference` binding (ABI v6).
 *
 * The strategic on-device voice engine is the single fused-FFI
 * `libelizainference` library (the merged llama.cpp fork — see
 * `plugins/plugin-local-inference/native/CLAUDE.md` §1). This class drives the
 * WeSpeaker ResNet34-LM speaker encoder through that one native handle via the
 * `eliza_inference_speaker_*` ABI. This is the SOLE on-device speaker-encoder
 * runtime — the same `ffi`/`ctx` pair powers VAD / wake-word / TTS / ASR, so the
 * whole voice pipeline runs through one library.
 *
 * Shape mirrors the legacy `encoder.ts::SpeakerEncoder` contract exactly:
 *   - 16 kHz mono fp32 PCM in,
 *   - one L2-normalized 256-d embedding out,
 *   - `encode(pcm)` / `dispose()`.
 *
 * No silent fallback: when the fused build does not export the speaker ABI
 * (`eliza_inference_speaker_supported() == 0`) `load()` throws a structured
 * `SpeakerEncoderGgmlUnavailableError` (AGENTS.md §3 — no synthetic
 * embeddings, no standalone-lib fallback).
 */

import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeSpeakerHandle,
} from "../ffi-bindings";
import type { SpeakerEncoder } from "./encoder";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "./encoder";
import {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
	SpeakerEncoderGgmlUnavailableError,
} from "./encoder-ggml";

export interface FusedSpeakerEncoderOptions {
	ffi: ElizaInferenceFfi;
	ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
	/**
	 * Optional explicit WeSpeaker GGUF path. `null` lets the native runtime
	 * resolve the bundle's `speaker/` dir (the default).
	 */
	ggufPath?: string | null;
}

/**
 * Fused-`libelizainference` WeSpeaker speaker encoder. Owns one
 * `eliza_inference_speaker_*` session; `encode()` runs one forward pass over
 * the supplied 16 kHz PCM and returns the normalized 256-d embedding. The
 * native side owns the model graph; this class is a thin handle.
 */
export class FusedSpeakerEncoder implements SpeakerEncoder {
	readonly embeddingDim = SPEAKER_GGML_EMBEDDING_DIM;
	readonly sampleRate = SPEAKER_GGML_SAMPLE_RATE;
	readonly modelId = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;
	private disposed = false;

	private constructor(
		private readonly ffi: ElizaInferenceFfi,
		private readonly handle: NativeSpeakerHandle,
	) {}

	/**
	 * True only when the fused `libelizainference` build exports the speaker
	 * ABI and advertises support at runtime.
	 */
	static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
		if (!ffi || typeof ffi.speakerSupported !== "function") return false;
		return ffi.speakerSupported();
	}

	/**
	 * Open a native speaker-encoder session. Throws
	 * `SpeakerEncoderGgmlUnavailableError` when the runtime is not present.
	 */
	static async load(
		opts: FusedSpeakerEncoderOptions,
	): Promise<FusedSpeakerEncoder> {
		if (!FusedSpeakerEncoder.isSupported(opts.ffi)) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"native-missing",
				"[speaker-fused] The native speaker encoder is not present in this libelizainference build. Rebuild with the WeSpeaker forward graph linked in (eliza_inference_speaker_* symbols).",
			);
		}
		if (
			!opts.ffi.speakerOpen ||
			!opts.ffi.speakerEmbed ||
			!opts.ffi.speakerClose
		) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-fused] Speaker support probe succeeded, but the required FFI methods are missing on the binding.",
			);
		}
		const ctx = typeof opts.ctx === "function" ? opts.ctx() : opts.ctx;
		const handle = opts.ffi.speakerOpen({
			ctx,
			ggufPath: opts.ggufPath ?? null,
		});
		return new FusedSpeakerEncoder(opts.ffi, handle);
	}

	async encode(pcm: Float32Array): Promise<Float32Array> {
		if (this.disposed) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-fused] encode called after dispose()",
			);
		}
		if (!(pcm instanceof Float32Array)) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				"[speaker-fused] pcm must be a Float32Array",
			);
		}
		if (pcm.length < SPEAKER_GGML_MIN_SAMPLES) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				`[speaker-fused] pcm too short: ${pcm.length} samples < ${SPEAKER_GGML_MIN_SAMPLES}`,
			);
		}
		const embed = this.ffi.speakerEmbed;
		if (!embed) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-fused] encode missing FFI method",
			);
		}
		return embed({ speaker: this.handle, pcm });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.ffi.speakerClose?.(this.handle);
	}
}
