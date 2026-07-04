/**
 * Engine ↔ voice scheduler bridge.
 *
 * Adapts the live `LocalInferenceEngine` (`engine.ts`) plus the MTP
 * llama-server (`ffi-streaming-backend.ts`) onto the voice scaffold's
 * `VoiceScheduler`. See `packages/inference/AGENTS.md` §4 for the
 * streaming graph this implements:
 *
 *   ASR → text tokens → MTP drafter ↔ target verifier (text model)
 *        → phrase chunker → speaker preset cache + phrase cache
 *        → OmniVoice TTS → PCM ring buffer → audio out
 *
 * Plus rollback queue (MTP rejection → cancel pending TTS chunks)
 * and barge-in cancellation (mic VAD → drain ring buffer + cancel TTS).
 *
 * Two TTS backends are exposed:
 *   - `StubTtsBackend`: deterministic synthetic PCM. Used by tests
 *     and any path that wants the streaming graph without real audio.
 *   - `FfiOmniVoiceBackend`: forwards through the fused
 *     `libelizainference.{dylib,so,dll}` ABI. The bridge creates the
 *     context lazily when voice is armed or first used, so voice-off
 *     does not keep OmniVoice weights resident.
 *
 * Per AGENTS.md §3 + §9 (no defensive code, no log-and-continue), every
 * startup precondition surfaces as a thrown `VoiceStartupError`. There
 * is no silent fallback to text-only.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { VoiceCancellationReason } from "@elizaos/shared";
import { localInferenceRoot } from "../paths";
import {
	type CoordinatorRuntime,
	VoiceCancellationCoordinator,
} from "./cancellation-coordinator";
import { VoiceStartupError } from "./errors";
import type {
	AsrWordTiming,
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeVerifierEvent,
} from "./ffi-bindings";
import { loadElizaInferenceFfi } from "./ffi-bindings";
import { KokoroTtsBackend } from "./kokoro/kokoro-backend";
import type { KokoroEngineDiscoveryResult } from "./kokoro/kokoro-engine-discovery";
import { pickKokoroRuntimeBackend } from "./kokoro/pick-runtime";
import {
	VoiceLifecycle,
	VoiceLifecycleError,
	type VoiceLifecycleLoaders,
} from "./lifecycle";
import {
	OptimisticGenerationPolicy,
	type OptimisticPolicyOptions,
	resolvePowerSourceState,
} from "./optimistic-policy";
import {
	type CachedPhraseAudio,
	DEFAULT_PHRASE_CACHE_SEED,
	FIRST_AUDIO_FILLERS,
	PhraseCache,
} from "./phrase-cache";
import {
	VoicePipeline,
	type VoicePipelineConfig,
	type VoicePipelineDeps,
	type VoicePipelineEvents,
} from "./pipeline";
import {
	MissingAsrTranscriber,
	MtpDraftProposer,
	MtpTargetVerifier,
	type MtpTextRunner,
} from "./pipeline-impls";
import type { VoiceProfileStore } from "./profile-store";
import { type SchedulerEvents, VoiceScheduler } from "./scheduler";
import {
	AgentSelfVoiceImprint,
	registerAgentSelfVoiceImprint,
} from "./self-voice-imprint";
import {
	type MmapRegionHandle,
	SharedResourceRegistry,
} from "./shared-resources";
import {
	type VoiceAttributionOutput,
	VoiceAttributionPipeline,
} from "./speaker/attribution-pipeline";
import {
	type Diarizer,
	PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
} from "./speaker/diarizer";
import { FusedDiarizer } from "./speaker/diarizer-fused";
import type { SpeakerEncoder } from "./speaker/encoder";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused";
import {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_SAMPLE_RATE,
} from "./speaker/encoder-ggml";
import {
	DEFAULT_VOICE_PRESET_REL_PATH,
	SpeakerPresetCache,
} from "./speaker-preset-cache";
import {
	pickStreamingMode,
	readStreamingAsrEnabledFromEnv,
	StabilizedStreamingTranscriber,
	type StreamingPipelineMode,
} from "./streaming-asr/streaming-pipeline-adapter";
import {
	ASR_SAMPLE_RATE,
	AsrUnavailableError,
	createStreamingTranscriber,
	DEFAULT_ASR_STEP_SECONDS,
	ffiSupportsStreamingAsr,
	readAsrBackendPreferenceFromEnv,
	readAsrStepSecondsFromEnv,
	resampleLinear,
} from "./transcriber";
import type {
	AudioChunk,
	AudioSink,
	Phrase,
	RejectedTokenRange,
	SchedulerConfig,
	SpeakerPreset,
	StreamingTranscriber,
	TextToken,
	TranscriptionAudio,
	TtsBackend,
	VadEventSource,
} from "./types";
import {
	KOKORO_TTS_TRANSIENT_PEAK_BYTES,
	OMNIVOICE_TTS_TRANSIENT_PEAK_BYTES,
} from "./voice-budget";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec";

const SAMPLE_RATE_DEFAULT = 24_000;
const RING_BUFFER_CAPACITY_DEFAULT = SAMPLE_RATE_DEFAULT * 4; // 4s
/**
 * Runtime default for the no-punctuation phrase cap (`PhraseChunker.maxTokensPerPhrase`).
 * Punctuation (`, . ! ?`) is still the primary boundary; this only bounds
 * a run-on token stream. Kept small — equal to the MTP draft window
 * (`DEFAULT_VOICE_MAX_DRAFT_TOKENS` in `engine.ts`) — so first-audio latency
 * is bounded (a phrase ≈ one draft round of audio, not 30 words) and a
 * MTP-reject rollback drops at most one un-spoken chunk (AGENTS.md §4 —
 * "small chunk = low latency cost on rollback"). Override per bridge via
 * `maxTokensPerPhrase` or `ELIZA_VOICE_MAX_TOKENS_PER_PHRASE`. The
 * `PhraseChunker` primitive keeps the AGENTS-spec 30-word default for
 * non-runtime callers.
 */
const PHRASE_MAX_TOKENS_DEFAULT = 8;
const STUB_PCM_MS_PER_PHRASE = 100;
const STUB_PCM_STREAM_CHUNKS = 4;

/**
 * Resolve the `speaker_preset_id` value to send across the FFI boundary.
 *
 * Historically this returned `null` for the default voice — the C side then
 * treated `null` as "auto-voice mode" and ignored any preset file under
 * `cache/voice-preset-default.bin`. That was the right behaviour when the
 * default preset was a 256-fp32-zero placeholder; it's wrong now that the
 * default preset can be a real (v2) OmniVoice sam freeze. With ABI v4
 * the FFI bridge looks up `<bundle>/cache/voice-preset-<id>.bin` when the
 * id is supplied and applies the `(instruct, ref_audio_tokens, ref_text)`
 * triple to `ov_tts_params` — so we must always pass the id.
 *
 * The only case we return `null` is when the preset shape is degenerate
 * (no embedding, no ref-audio-tokens, no instruct) — i.e. an explicit
 * "no preset" signal from a caller that doesn't want a voice bound. The
 * FFI side honours `null` by running OmniVoice's intrinsic auto-voice
 * path.
 */
function ffiSpeakerPresetId(preset: SpeakerPreset): string | null {
	const hasV2Payload =
		(preset.instruct !== undefined && preset.instruct.length > 0) ||
		(preset.refText !== undefined && preset.refText.length > 0) ||
		(preset.refAudioTokens !== undefined &&
			preset.refAudioTokens.tokens.length > 0);
	const hasEmbedding = preset.embedding.length > 0;
	if (!hasV2Payload && !hasEmbedding) {
		// Degenerate preset (e.g. the 1052-byte all-zero placeholder). The C
		// side cannot do anything useful with it; let OmniVoice pick its own
		// voice via the auto-voice path.
		return null;
	}
	return preset.voiceId;
}

/** Re-exported from `./errors` so existing `engine-bridge` importers don't churn. */
export { VoiceStartupError };

/**
 * Native verifier callbacks report rejected token ranges as half-open
 * `[from, to)` intervals. The scheduler rollback queue uses inclusive
 * token indexes, so convert in exactly one place.
 */
export function nativeRejectedRangeToRollbackRange(
	event: Pick<NativeVerifierEvent, "rejectedFrom" | "rejectedTo">,
): RejectedTokenRange | null {
	if (event.rejectedFrom < 0 || event.rejectedTo <= event.rejectedFrom) {
		return null;
	}
	return {
		fromIndex: event.rejectedFrom,
		toIndex: event.rejectedTo - 1,
	};
}

/**
 * One PCM segment delivered to a `StreamingTtsBackend.synthesizeStream`
 * consumer (W9's scheduler) as TTS decodes it. `isFinal` marks the
 * zero-length tail chunk that closes the phrase.
 */
export interface TtsPcmChunk {
	pcm: Float32Array;
	sampleRate: number;
	isFinal: boolean;
}

/**
 * Streaming-TTS seam between the fused `libelizainference` runtime and
 * W9's voice scheduler. The scheduler calls `synthesizeStream(...)` for
 * a phrase and writes each delivered `pcm` segment into the
 * `PcmRingBuffer` on the same scheduler tick (AGENTS.md §4 —
 * phrase-chunk → TTS within one scheduler tick); returning `true` from
 * `onChunk` (or flipping `cancelSignal.cancelled`) hard-cancels the
 * in-flight forward pass at the next kernel boundary (barge-in /
 * MTP-rejected tail).
 *
 * Both `TtsBackend` implementations in this module satisfy it:
 *   - `FfiOmniVoiceBackend` forwards to
 *     `eliza_inference_tts_synthesize_stream` when the loaded build
 *     advertises streaming TTS (`tts_stream_supported() == 1`), else it
 *     synthesizes whole and emits the result as one body chunk + a final
 *     tail (no silent "streaming" lie — the chunk count just collapses
 *     to one when the build is non-streaming);
 *   - `StubTtsBackend` emits deterministic synthetic PCM split
 *     into a fixed number of chunks so scheduler tests can observe the
 *     incremental handoff without a real model.
 */
export interface StreamingTtsBackend {
	/**
	 * Synthesize `phrase` with `preset` and deliver PCM in chunks. The
	 * scheduler owns the ring-buffer write inside `onChunk`. Resolves with
	 * `cancelled: true` if `onChunk` requested a stop (or `cancelSignal`
	 * was set), `false` on a clean finish. The final `onChunk` call always
	 * has `isFinal: true` (possibly a zero-length `pcm`) so the consumer
	 * can settle per-phrase state.
	 */
	synthesizeStream(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
		onKernelTick?: () => void;
	}): Promise<{ cancelled: boolean }>;
}

/** True when `backend` implements the `StreamingTtsBackend` seam. */
export function isStreamingTtsBackend(
	backend: TtsBackend,
): backend is TtsBackend & StreamingTtsBackend {
	return (
		typeof (backend as Partial<StreamingTtsBackend>).synthesizeStream ===
		"function"
	);
}

/**
 * Deterministic test TTS backend. Each phrase yields
 * `STUB_PCM_MS_PER_PHRASE` ms of silence (zeros), with the
 * cancel signal honoured at the kernel-tick boundary so barge-in tests
 * observe cancellation without waiting on a real model.
 */
export class StubTtsBackend implements TtsBackend, StreamingTtsBackend {
	readonly id = "stub" as const;
	private readonly sampleRate: number;
	calls = 0;
	streamCalls = 0;

	constructor(sampleRate = SAMPLE_RATE_DEFAULT) {
		this.sampleRate = sampleRate;
	}

	async synthesize(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onKernelTick?: () => void;
	}): Promise<AudioChunk> {
		this.calls++;
		args.onKernelTick?.();
		const samples = Math.floor(
			(this.sampleRate * STUB_PCM_MS_PER_PHRASE) / 1000,
		);
		const pcm = new Float32Array(samples);
		return {
			phraseId: args.phrase.id,
			fromIndex: args.phrase.fromIndex,
			toIndex: args.phrase.toIndex,
			pcm,
			sampleRate: this.sampleRate,
		};
	}

	async synthesizeStream(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
		onKernelTick?: () => void;
	}): Promise<{ cancelled: boolean }> {
		this.streamCalls++;
		const totalSamples = Math.floor(
			(this.sampleRate * STUB_PCM_MS_PER_PHRASE) / 1000,
		);
		const perChunk = Math.max(
			1,
			Math.ceil(totalSamples / STUB_PCM_STREAM_CHUNKS),
		);
		let cancelled = false;
		for (let off = 0; off < totalSamples; off += perChunk) {
			args.onKernelTick?.();
			if (args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
			const n = Math.min(perChunk, totalSamples - off);
			const want = args.onChunk({
				pcm: new Float32Array(n),
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			if (want === true || args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled };
	}
}

/**
 * FFI-backed TTS backend. Forwards each `synthesize()` call through the
 * fused `libelizainference` ABI declared in
 * `packages/app-core/scripts/omnivoice-fuse/ffi.h`. The library handle
 * + a per-engine context pointer are held by the bridge and passed in
 * at construction so this backend stays a thin adapter.
 *
 * Until the real fused build ships, the binding is exercised against
 * the compatibility C library at `scripts/omnivoice-fuse/ffi-stub.c`, which returns
 * `ELIZA_ERR_NOT_IMPLEMENTED` for `tts_synthesize` — the binding then
 * raises `VoiceLifecycleError({code:"kernel-missing"})`. The adapter
 * re-wraps that as `VoiceStartupError("missing-fused-build", ...)` so
 * the engine layer's startup-error taxonomy stays unified. No silent
 * fallback (AGENTS.md §3 + §9).
 */
export class FfiOmniVoiceBackend implements TtsBackend, StreamingTtsBackend {
	readonly id = "ffi" as const;
	private readonly ffi: ElizaInferenceFfi;
	private readonly getContext: () => ElizaInferenceContextHandle;
	private readonly sampleRate: number;
	private readonly maxSecondsPerPhrase: number;

	constructor(args: {
		ffi: ElizaInferenceFfi;
		ctx?: ElizaInferenceContextHandle;
		getContext?: () => ElizaInferenceContextHandle;
		sampleRate?: number;
		maxSecondsPerPhrase?: number;
	}) {
		this.ffi = args.ffi;
		this.getContext =
			args.getContext ??
			(() => {
				if (args.ctx === undefined) {
					throw new VoiceStartupError(
						"missing-fused-build",
						"[voice] FFI backend has no context provider",
					);
				}
				return args.ctx;
			});
		this.sampleRate = args.sampleRate ?? SAMPLE_RATE_DEFAULT;
		this.maxSecondsPerPhrase = args.maxSecondsPerPhrase ?? 6;
	}

	/** True when the loaded `libelizainference` advertises streaming TTS. */
	supportsStreamingTts(): boolean {
		return this.ffi.ttsStreamSupported();
	}

	/**
	 * One-shot synthesis returning the whole phrase as an `AudioChunk`.
	 * When the loaded build advertises streaming TTS this routes through
	 * `eliza_inference_tts_synthesize_stream` and concatenates the
	 * delivered chunks (so the chunk-aware native path is exercised even
	 * for whole-phrase callers); otherwise it uses the batch
	 * `eliza_inference_tts_synthesize` symbol. `cancelSignal` is honoured
	 * at chunk boundaries — a cancelled stream returns whatever was
	 * synthesized so far.
	 */
	async synthesize(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onKernelTick?: () => void;
	}): Promise<AudioChunk> {
		args.onKernelTick?.();
		const ctx = this.getContext();
		if (this.ffi.ttsStreamSupported()) {
			const parts: Float32Array[] = [];
			let total = 0;
			this.ffi.ttsSynthesizeStream({
				ctx,
				text: args.phrase.text,
				speakerPresetId: ffiSpeakerPresetId(args.preset),
				onChunk: ({ pcm, isFinal }) => {
					args.onKernelTick?.();
					if (!isFinal && pcm.length > 0) {
						parts.push(pcm);
						total += pcm.length;
					}
					return args.cancelSignal.cancelled === true;
				},
			});
			const merged = new Float32Array(total);
			let off = 0;
			for (const part of parts) {
				merged.set(part, off);
				off += part.length;
			}
			return {
				phraseId: args.phrase.id,
				fromIndex: args.phrase.fromIndex,
				toIndex: args.phrase.toIndex,
				pcm: merged,
				sampleRate: this.sampleRate,
			};
		}
		const out = new Float32Array(this.sampleRate * this.maxSecondsPerPhrase);
		const samples = this.ffi.ttsSynthesize({
			ctx,
			text: args.phrase.text,
			speakerPresetId: ffiSpeakerPresetId(args.preset),
			out,
		});
		return {
			phraseId: args.phrase.id,
			fromIndex: args.phrase.fromIndex,
			toIndex: args.phrase.toIndex,
			pcm: out.subarray(0, samples),
			sampleRate: this.sampleRate,
		};
	}

	/**
	 * Streaming synthesis: forwards to `eliza_inference_tts_synthesize_stream`
	 * when the build advertises a streaming decoder. When it does NOT
	 * (`tts_stream_supported() == 0`), this still satisfies the seam — but
	 * with exactly one body chunk + one final tail (the batch synthesis
	 * result), so the caller never mistakes a non-streaming build for a
	 * streaming one (no fallback sludge — the chunk count is the honest
	 * signal). The native side checks `ctx->tts_cancel` (set via
	 * `eliza_inference_cancel_tts`) on top of the `onChunk` return value.
	 * A non-streaming build cannot be interrupted while the native batch
	 * forward pass is inside `ttsSynthesize`; it only observes cancellation
	 * before emitting the body chunk. Barge-in-critical product paths should
	 * require `supportsStreamingTts()`.
	 */
	async synthesizeStream(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
		onKernelTick?: () => void;
	}): Promise<{ cancelled: boolean }> {
		const ctx = this.getContext();
		if (this.ffi.ttsStreamSupported()) {
			const { cancelled } = this.ffi.ttsSynthesizeStream({
				ctx,
				text: args.phrase.text,
				speakerPresetId: ffiSpeakerPresetId(args.preset),
				onChunk: ({ pcm, isFinal }) => {
					args.onKernelTick?.();
					if (args.cancelSignal.cancelled) return true;
					const want = args.onChunk({
						pcm,
						sampleRate: this.sampleRate,
						isFinal,
					});
					// Re-read the (mutable) cancel flag — the chunk callback or a
					// concurrent barge-in may have flipped it.
					return want === true || args.cancelSignal.cancelled;
				},
			});
			return { cancelled };
		}
		// Non-streaming build: one batch forward pass, surfaced as a single
		// body chunk + final tail.
		args.onKernelTick?.();
		const out = new Float32Array(this.sampleRate * this.maxSecondsPerPhrase);
		const samples = this.ffi.ttsSynthesize({
			ctx,
			text: args.phrase.text,
			speakerPresetId: ffiSpeakerPresetId(args.preset),
			out,
		});
		let cancelled = args.cancelSignal.cancelled === true;
		if (!cancelled && samples > 0) {
			const want = args.onChunk({
				pcm: out.subarray(0, samples),
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			cancelled = want === true || args.cancelSignal.cancelled === true;
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled };
	}

	/** Hard-cancel any in-flight TTS forward pass on this backend's context. */
	cancelTts(): void {
		this.ffi.cancelTts(this.getContext());
	}

	/**
	 * Batch transcription. One-shot callers should use the fused batch ABI
	 * directly so the native side receives the original sample-rate metadata
	 * and can apply its own audio preprocessing. Live mic streaming remains
	 * available through `EngineVoiceBridge.createStreamingTranscriber()`.
	 */
	async transcribe(args: TranscriptionAudio): Promise<string> {
		return this.ffi.asrTranscribe({
			ctx: this.getContext(),
			pcm: args.pcm,
			sampleRateHz: args.sampleRate,
		});
	}

	/** Transcribe + per-word timings when the fused build is ABI v12+; otherwise
	 *  the text with empty `words` (the caller degrades to segment highlight). */
	async transcribeTimed(
		args: TranscriptionAudio,
	): Promise<{ text: string; words: AsrWordTiming[] }> {
		if (this.ffi.timedAsrSupported()) {
			const res = this.ffi.asrTranscribeTimed({
				ctx: this.getContext(),
				pcm: args.pcm,
				sampleRateHz: args.sampleRate,
			});
			return { text: res.text.trim(), words: res.words };
		}
		logger.debug(
			"[FfiOmniVoiceBackend] timedAsrSupported()===false on the active fused build — per-word timings dropped, transcript player degrades to segment-level highlight",
		);
		return { text: (await this.transcribe(args)).trim(), words: [] };
	}
}

/** Warn once per process when the fused speaker runtime is absent (#12257). */
let speakerAttributionUnavailableWarned = false;
function warnSpeakerAttributionUnavailableOnce(reason: string): void {
	if (speakerAttributionUnavailableWarned) return;
	speakerAttributionUnavailableWarned = true;
	logger.warn(
		`[EngineVoiceBridge] Speaker attribution requested but ${reason}. Voice continues without attribution.`,
	);
}

export interface EngineVoiceBridgeOptions {
	/**
	 * Bundle root on disk. Must contain `cache/voice-preset-default.bin`
	 * and the FFI library (`lib/libelizainference.{dylib,so}`) when
	 * `useFfiBackend === true`.
	 */
	bundleRoot: string;
	/**
	 * When true, use `FfiOmniVoiceBackend`. When false, use the deterministic test backend
	 * only for lifecycle/unit tests; live sessions and direct synthesis reject
	 * the deterministic test backend before user-visible audio can be emitted.
	 */
	useFfiBackend: boolean;
	/** Override sample rate. Defaults to 24 kHz. */
	sampleRate?: number;
	/** Override ring buffer capacity (samples). Defaults to 4 s @ 24 kHz. */
	ringBufferCapacity?: number;
	/** Phrase chunker `maxTokensPerPhrase` (no-punctuation run-on cap). Defaults to
	 *  `ELIZA_VOICE_MAX_TOKENS_PER_PHRASE` or 8 (one MTP draft round). */
	maxTokensPerPhrase?: number;
	/** Max concurrent TTS phrase dispatches. Defaults to env or scheduler default. */
	maxInFlightPhrases?: number;
	/**
	 * Pre-warmed phrase cache entries. Per AGENTS.md §4, a precomputed
	 * phrase cache for common assistant utterances is mandatory for the
	 * first-byte-latency win. Empty by default — callers wire actual
	 * entries from the bundle when available.
	 */
	prewarmedPhrases?: ReadonlyArray<CachedPhraseAudio>;
	/**
	 * Optional sink override (e.g. for tests or for routing PCM to a
	 * platform-specific audio device). Defaults to the in-memory sink the
	 * scheduler creates.
	 */
	sink?: AudioSink;
	/** Optional scheduler event listeners (rollback, audio, cancel). */
	events?: SchedulerEvents;
	/**
	 * Optional override for the TTS backend. When set, supersedes
	 * `useFfiBackend`. Tests use this to inject a controllable backend
	 * (e.g. one that holds synthesis open until a deferred resolves) so
	 * rollback timing can be observed deterministically.
	 */
	backendOverride?: TtsBackend;
	/**
	 * Override only the TTS backend while keeping the fused bundle lifecycle
	 * and ASR FFI loaded. Used when a bundle falls back from OmniVoice speech
	 * to Kokoro speech but still needs bundled Gemma ASR for mic input.
	 */
	ttsBackendOverride?: TtsBackend;
	/** Optional speaker preset paired with `ttsBackendOverride`. */
	speakerPresetOverride?: SpeakerPreset;
	/**
	 * Optional shared resource registry. When the bridge is created
	 * inside an engine that already owns one (text + voice on the same
	 * tokenizer / mmap regions), the engine passes its registry in so
	 * voice ref-counts against the same canonical resources. Tests can
	 * leave this unset to get a private registry.
	 */
	sharedResources?: SharedResourceRegistry;
	/**
	 * Optional lifecycle loaders override. Production wires real
	 * `madvise`-backed mmap handles via the FFI; tests inject mocks so
	 * the disarm path can assert eviction without a real file mapping.
	 * When unset, default loaders are derived from the bundle root.
	 */
	lifecycleLoaders?: VoiceLifecycleLoaders;
	/**
	 * Construct a `KokoroTtsBackend` directly and skip the bundle-root +
	 * speaker-preset + FFI checks the fused omnivoice path requires.
	 * Kokoro voices are picked by id (`KOKORO_VOICE_PACKS`), so the bundle's
	 * per-user speaker preset is not used. Mutually exclusive with
	 * `useFfiBackend: true` and `backendOverride`. Lifecycle loaders
	 * default to empty lifecycle handles (ORT owns the model memory; nothing to
	 * mmap-evict).
	 */
	kokoroOnly?: KokoroEngineDiscoveryResult;
	/**
	 * Optional pre-loaded fused inference handle for the `kokoroOnly` path. When
	 * set, the Kokoro FFI runtime reuses it instead of dlopen-ing a second copy
	 * of `libelizainference` (tests inject a stub; production may share the
	 * engine's handle).
	 */
	kokoroFfi?: ElizaInferenceFfi;
	/**
	 * Optional voice-profile store for speaker-attribution. When set, the
	 * bridge constructs a `VoiceAttributionPipeline` and runs attribution
	 * in parallel with ASR on every turn via `runVoiceTurn`. Callers receive
	 * the resolved `VoiceAttributionOutput` via `onAttribution` in the turn
	 * events passed to `runVoiceTurn`.
	 *
	 * When absent, attribution is skipped and the pipeline operates exactly
	 * as before (no diarizer / encoder overhead).
	 */
	profileStore?: VoiceProfileStore;
	/**
	 * W3-9 / F1 — the agent runtime. When supplied, the bridge constructs a
	 * `VoiceCancellationCoordinator` and an `OptimisticGenerationPolicy`
	 * scoped to this voice session. The coordinator owns one cancellation
	 * token per `roomId` and fans abort out to:
	 *   1. `runtime.turnControllers.abortTurn(roomId, reason)` — the
	 *      planner-loop / action handlers / streaming `useModel` see the
	 *      abort within one tick.
	 *   2. The slot-abort callback (`slotAbort`) when the LM slot id is
	 *      registered with the turn.
	 *   3. The TTS hard-stop callback (`ttsStop`), which the bridge wires
	 *      to its existing `triggerBargeIn()` (audio sink drain + FFI/HTTP
	 *      synthesis cancel).
	 *   4. The standard `AbortSignal` every fetch / `useModel` / FFI call
	 *      that took `token.signal` honours.
	 *
	 * The reverse direction (runtime → voice) is wired symmetrically via
	 * the coordinator's `runtime.turnControllers.onEvent` subscription.
	 *
	 * Omit to keep the prior behaviour — the bridge then exposes no
	 * coordinator / policy and callers fall back to the legacy
	 * `BargeInController` + `triggerBargeIn()` surface.
	 *
	 * Structural type — `CoordinatorRuntime` is the minimum surface the
	 * coordinator needs (`turnControllers.{abortTurn, onEvent}`). Production
	 * passes a full `IAgentRuntime`; tests can pass a fake matching the
	 * structural shape.
	 */
	runtime?: IAgentRuntime | CoordinatorRuntime;
	/**
	 * W3-9 / F1 — optional `OptimisticGenerationPolicy` overrides. When
	 * `runtime` is set and `optimisticPolicyOptions` is omitted, the bridge
	 * constructs a default policy gated on the resolved power source
	 * (plugged-in / battery / unknown) and the canonical EOT threshold.
	 */
	optimisticPolicyOptions?: OptimisticPolicyOptions;
	/**
	 * W3-9 / F1 — optional LM slot-abort callback for the cancellation
	 * coordinator. Production wires this to `MtpLlamaServer.abortSlot`
	 * once a slot id is known per turn. The bridge passes this directly
	 * into the coordinator; the bridge itself does not own slot ids.
	 *
	 * Has no effect when `runtime` is unset (no coordinator is constructed).
	 */
	slotAbort?: (slotId: number, reason: VoiceCancellationReason) => void;
	/**
	 * Live speaker-attribution gating. When set alongside a `profileStore` AND
	 * a full `runtime` (with `emitEvent`), `runVoiceTurn` automatically:
	 *   1. emits `VOICE_TURN_OBSERVED` for every attributed turn, and
	 *   2. folds the diarization decision into the turn's `voiceTurnSignal`
	 *      (stamped onto `output.turn.metadata`) so the server gate
	 *      `core.voice_turn_signal` can suppress confident-bystander cross-talk.
	 *
	 * `knownSpeakerEntityIds` / `ownerEntityId` may be functions so the caller
	 * can resolve the enrolled-speaker set lazily per turn (the household roster
	 * changes as people are named). When omitted, attribution still emits
	 * `VOICE_TURN_OBSERVED` and produces a fail-open signal (no bystander
	 * suppression — every attribution is treated as potentially addressed to us).
	 */
	liveAttribution?: LiveAttributionConfig;
}

/** Gating inputs for the automatic live-attribution → voiceTurnSignal seam. */
export interface LiveAttributionConfig {
	/** Owner / primary-enrolled entity id (always allowed to speak). */
	ownerEntityId?: string | (() => string | null | undefined);
	/** Entity ids the agent answers without a wake word (owner + enrolled). */
	knownSpeakerEntityIds?:
		| readonly string[]
		| (() => readonly string[] | undefined);
	/** True when a wake word fired within the recent listen window. */
	wakeWordActive?: boolean | (() => boolean);
}

export function createKokoroTtsBackend(
	kokoro: KokoroEngineDiscoveryResult,
	opts: { bundleRoot?: string; ffi?: ElizaInferenceFfi } = {},
): KokoroTtsBackend {
	// In-process FFI is the sole Kokoro synthesis path on every platform — it
	// runs inside the fused libelizainference handle, the only path that ships
	// on iOS / Google Play (no local TCP socket). The legacy HTTP `fork`
	// (llama-server /v1/audio/speech) runtime was removed. An already-loaded
	// fused handle may be injected (`opts.ffi`) so Kokoro reuses it instead of
	// dlopen-ing a second copy of the lib.
	const decision = pickKokoroRuntimeBackend({
		defaultBackend: "ffi",
		ffi: {
			layout: kokoro.layout,
			bundleRoot: opts.bundleRoot,
			...(opts.ffi ? { ffi: opts.ffi } : {}),
		},
	});
	logger.info(
		`[voice/kokoro] runtime backend=${decision.backend} reason="${decision.reason}"`,
	);
	return new KokoroTtsBackend({
		layout: kokoro.layout,
		runtime: decision.runtime,
		defaultVoiceId: kokoro.defaultVoiceId,
	});
}

export function createKokoroSpeakerPreset(
	kokoro: KokoroEngineDiscoveryResult,
): SpeakerPreset {
	return {
		voiceId: kokoro.defaultVoiceId,
		embedding: new Float32Array(0),
		bytes: new Uint8Array(0),
	};
}

/**
 * Per-turn events that include the optional attribution result alongside
 * the existing `VoicePipelineEvents`. The attribution runs in parallel
 * with ASR; it resolves some time after `onAsrComplete` and before
 * `onComplete`.
 */
export interface VoiceTurnEvents extends VoicePipelineEvents {
	/**
	 * Called once per turn when the `VoiceAttributionPipeline` resolves
	 * (diarizer + encoder + profile-store match). Only fired when the
	 * bridge was constructed with a `profileStore`. May arrive after
	 * `onAsrComplete` but before `onComplete`. Fire-and-forget from the
	 * bridge's perspective — callers attach the metadata to the turn's
	 * transcript asynchronously.
	 */
	onAttribution?(output: VoiceAttributionOutput): void;
}

/**
 * Internal helper: construct the W3-9 cancellation coordinator + the
 * optimistic-generation policy for a session, given the bridge options.
 * Returns null/null when no runtime was supplied (the bridge then operates
 * without the W3-9 surface — back-compat for callers that haven't adopted
 * the canonical cancellation token yet).
 *
 * Lives outside the class so both `start()` and `startKokoroOnly()` can
 * share it without duplicating the construction order (the coordinator's
 * `ttsStop` callback closes over the to-be-constructed bridge — we plumb
 * that through `setTtsStop` after the bridge is built).
 */
interface PendingCancellationWiring {
	coordinator: VoiceCancellationCoordinator;
	policy: OptimisticGenerationPolicy;
	/** Wire the bridge's `triggerBargeIn` as the ttsStop callback. */
	bindTtsStop(stop: () => void): void;
}

/**
 * True when `runtime` is a full `IAgentRuntime` (exposes `emitEvent`) rather
 * than the structural `CoordinatorRuntime` a test may pass. Only an
 * event-capable runtime can drive the automatic `VOICE_TURN_OBSERVED` emit.
 */
function isEventRuntime(
	runtime: IAgentRuntime | CoordinatorRuntime | undefined,
): runtime is IAgentRuntime {
	return (
		runtime !== undefined &&
		typeof (runtime as { emitEvent?: unknown }).emitEvent === "function"
	);
}

/**
 * Flatten the (possibly lazy) `LiveAttributionConfig` into the plain options
 * the runtime helper consumes. Resolved per turn so a changing household roster
 * is picked up without re-arming voice.
 *
 * `transcript` is the turn's joined ASR text. The in-process engine owns ASR, so
 * it threads the real transcript through to `handleLiveVoiceAttribution` — the
 * merge engine's live name/partner extraction (`VoiceObserver.ingestTurn`) needs
 * *what* was said, not just *who* said it (#8786). When empty it is omitted, so
 * the helper falls back to "" exactly as before and diarization-only callers are
 * unaffected.
 */
function resolveLiveAttributionOptions(
	cfg: LiveAttributionConfig | null,
	transcript = "",
): {
	ownerEntityId?: string | null;
	knownSpeakerEntityIds?: readonly string[];
	wakeWordActive?: boolean;
	transcript?: string;
} {
	const transcriptOpt = transcript !== "" ? { transcript } : {};
	if (!cfg) return transcriptOpt;
	const ownerEntityId =
		typeof cfg.ownerEntityId === "function"
			? cfg.ownerEntityId()
			: cfg.ownerEntityId;
	const knownSpeakerEntityIds =
		typeof cfg.knownSpeakerEntityIds === "function"
			? cfg.knownSpeakerEntityIds()
			: cfg.knownSpeakerEntityIds;
	const wakeWordActive =
		typeof cfg.wakeWordActive === "function"
			? cfg.wakeWordActive()
			: cfg.wakeWordActive;
	return {
		...(ownerEntityId !== undefined ? { ownerEntityId } : {}),
		...(knownSpeakerEntityIds !== undefined ? { knownSpeakerEntityIds } : {}),
		...(wakeWordActive !== undefined ? { wakeWordActive } : {}),
		...transcriptOpt,
	};
}

function buildCancellationWiring(
	opts: EngineVoiceBridgeOptions,
): PendingCancellationWiring | null {
	if (!opts.runtime) return null;
	let ttsStopHandler: (() => void) | null = null;
	const coordinator = new VoiceCancellationCoordinator({
		runtime: opts.runtime,
		...(opts.slotAbort ? { slotAbort: opts.slotAbort } : {}),
		ttsStop: () => {
			if (ttsStopHandler) {
				ttsStopHandler();
			}
		},
	});
	const policy = new OptimisticGenerationPolicy(
		opts.optimisticPolicyOptions ?? {},
	);
	policy.setPowerSource(resolvePowerSourceState());
	return {
		coordinator,
		policy,
		bindTtsStop(stop) {
			ttsStopHandler = stop;
		},
	};
}

/**
 * Wires the voice scaffold (`VoiceScheduler` + helpers) onto the engine.
 * One bridge per active voice session — created in
 * `LocalInferenceEngine.startVoice()` and disposed when the engine
 * unloads or `stopVoice()` is called.
 */
export class EngineVoiceBridge {
	readonly scheduler: VoiceScheduler;
	readonly backend: TtsBackend;
	readonly lifecycle: VoiceLifecycle;
	/** Loaded FFI handle when running against the fused build (else null). */
	readonly ffi: ElizaInferenceFfi | null;
	/** Lazily-created FFI context this bridge owns; destroyed in `dispose()`. */
	private readonly ffiContextRef: FfiContextRef | null;
	readonly asrAvailable: boolean;
	private readonly bundleRoot: string;
	/** The phrase cache the scheduler dispatches against — held so the bridge
	 *  can answer "is phrase X cached" for the first-audio filler and seed the
	 *  idle-time auto-prewarm. */
	private readonly phraseCache: PhraseCache;
	/** In-flight fused turn (`runVoiceTurn`), if any — cancelled on barge-in. */
	private activePipeline: VoicePipeline | null = null;
	/**
	 * Optional attribution pipeline. Populated when the bridge was created
	 * with a `profileStore` option. When present, `runVoiceTurn` fires
	 * attribution in parallel with ASR and delivers the result via
	 * `VoiceTurnEvents.onAttribution`.
	 */
	private readonly attributionPipeline: VoiceAttributionPipeline | null;
	/**
	 * Full agent runtime, retained only when `opts.runtime` supports
	 * `emitEvent` (i.e. it is a real `IAgentRuntime`, not the structural
	 * `CoordinatorRuntime` a test may pass). Used by the automatic
	 * live-attribution seam in `runVoiceTurn` to emit `VOICE_TURN_OBSERVED`.
	 * Null when no event-capable runtime was supplied.
	 */
	private readonly eventRuntime: IAgentRuntime | null;
	/** Gating inputs for the live-attribution → voiceTurnSignal seam. */
	private readonly liveAttribution: LiveAttributionConfig | null;
	/**
	 * W3-9 / F1 — voice cancellation coordinator. Populated when the bridge
	 * was created with a `runtime` option. Owns one
	 * `VoiceCancellationToken` per active `roomId` and fans abort out to
	 * the runtime turn controller, the LM slot, the TTS pipeline, and the
	 * standard `AbortSignal`. See `cancellation-coordinator.ts` for the
	 * full contract.
	 */
	private readonly cancellationCoordinator: VoiceCancellationCoordinator | null;
	/**
	 * W3-9 / F1 — optimistic-generation policy. Constructed once per
	 * session when `runtime` is supplied. Gates the speculative LM prefill
	 * at the `firePrefill` site (see `voice-state-machine.ts`). Hot-swappable
	 * via `setPowerSource()` / `setOverride()` from Settings or a device-
	 * event listener.
	 */
	private readonly optimisticGenerationPolicy: OptimisticGenerationPolicy | null;
	/**
	 * W3-9 / F1 — per-room `BargeInController` bindings the bridge owns.
	 * Holds the unsubscribe handle returned by
	 * `coordinator.bindBargeInController` so `dispose()` can tear them down.
	 */
	private readonly bargeInBindings = new Map<string, () => void>();

	private constructor(
		scheduler: VoiceScheduler,
		backend: TtsBackend,
		bundleRoot: string,
		lifecycle: VoiceLifecycle,
		ffi: ElizaInferenceFfi | null,
		ffiContextRef: FfiContextRef | null,
		asrAvailable: boolean,
		phraseCache: PhraseCache,
		attributionPipeline: VoiceAttributionPipeline | null = null,
		private readonly selfVoiceImprint: AgentSelfVoiceImprint | null = null,
		cancellationCoordinator: VoiceCancellationCoordinator | null = null,
		optimisticGenerationPolicy: OptimisticGenerationPolicy | null = null,
		eventRuntime: IAgentRuntime | null = null,
		liveAttribution: LiveAttributionConfig | null = null,
	) {
		this.scheduler = scheduler;
		this.backend = backend;
		this.bundleRoot = bundleRoot;
		this.lifecycle = lifecycle;
		this.ffi = ffi;
		this.ffiContextRef = ffiContextRef;
		this.asrAvailable = asrAvailable;
		this.phraseCache = phraseCache;
		this.attributionPipeline = attributionPipeline;
		this.cancellationCoordinator = cancellationCoordinator;
		this.optimisticGenerationPolicy = optimisticGenerationPolicy;
		this.eventRuntime = eventRuntime;
		this.liveAttribution = liveAttribution;
	}

	get ffiCtx(): ElizaInferenceContextHandle | null {
		return this.ffiContextRef?.current ?? null;
	}

	/**
	 * Tear down the FFI context the bridge owns. Idempotent; safe to call
	 * multiple times. Callers should `disarm()` first to drop voice
	 * resources, then `dispose()` to close the FFI handle.
	 */
	dispose(): void {
		// W3-9 / F1 — tear down barge-in bindings + the cancellation
		// coordinator first so any armed turn aborts with reason=external
		// before the FFI context goes away.
		for (const unsub of Array.from(this.bargeInBindings.values())) {
			try {
				unsub();
			} catch {
				// Best-effort teardown.
			}
		}
		this.bargeInBindings.clear();
		if (this.cancellationCoordinator) {
			try {
				this.cancellationCoordinator.dispose();
			} catch {
				// Coordinator dispose must not block FFI teardown.
			}
		}
		if (this.ffi) {
			const ctx = this.ffiContextRef?.current ?? null;
			if (ctx !== null) {
				this.ffi.destroy(ctx);
				if (this.ffiContextRef) this.ffiContextRef.current = null;
			}
			this.ffi.close();
		}
	}

	/**
	 * Start the voice session for a bundle. Validates the bundle layout
	 * up-front (per AGENTS.md §3 + §7 — required artifacts checked before
	 * activation) and throws `VoiceStartupError` for any missing piece.
	 * No partial activation: either the scheduler exists and is wired or
	 * the call throws.
	 */
	static start(opts: EngineVoiceBridgeOptions): EngineVoiceBridge {
		if (opts.kokoroOnly) {
			if (opts.useFfiBackend || opts.backendOverride) {
				throw new VoiceStartupError(
					"invalid-options",
					"[voice] kokoroOnly cannot be combined with useFfiBackend or backendOverride. Caller must pick exactly one backend path.",
				);
			}
			return EngineVoiceBridge.startKokoroOnly(opts);
		}
		if (!opts.bundleRoot || !existsSync(opts.bundleRoot)) {
			throw new VoiceStartupError(
				"missing-bundle-root",
				`[voice] Bundle root does not exist: ${opts.bundleRoot}`,
			);
		}

		const presetPath = path.join(
			opts.bundleRoot,
			DEFAULT_VOICE_PRESET_REL_PATH,
		);
		if (!existsSync(presetPath)) {
			throw new VoiceStartupError(
				"missing-speaker-preset",
				`[voice] Bundle is missing required speaker preset at ${presetPath}. The default voice MUST ship as a precomputed embedding (AGENTS.md §4).`,
			);
		}

		const sampleRate = opts.sampleRate ?? SAMPLE_RATE_DEFAULT;
		const presetCache = new SpeakerPresetCache();
		const { preset, phrases: seedPhrases } = presetCache.loadFromBundle({
			bundleRoot: opts.bundleRoot,
		});
		const schedulerPreset = opts.speakerPresetOverride ?? preset;

		const phraseCache = new PhraseCache();
		phraseCache.seed(seedPhrases);
		for (const entry of opts.prewarmedPhrases ?? []) {
			phraseCache.put(entry);
		}

		// FFI binding + per-bridge context. When the bridge runs against
		// the real fused build, the same `ffi`/`ctx` pair is shared by:
		//   - the TTS backend (`FfiOmniVoiceBackend.synthesize`),
		//   - the lifecycle loaders (`MmapRegionHandle.evictPages` calls
		//     `ffi.mmapEvict(ctx, "tts" | "asr")`).
		// Tests can opt out by either passing `lifecycleLoaders` (mocks
		// `evictPages`) or `backendOverride` (mocks the backend) or
		// setting `useFfiBackend: false` (test TTS + empty evict transition).
		let ffiHandle: ElizaInferenceFfi | null = null;
		let ffiContextRef: FfiContextRef | null = null;
		let backend: TtsBackend;
		const asrAvailable = bundleHasRegularFile(
			path.join(opts.bundleRoot, "asr"),
		);
		if (opts.backendOverride && opts.ttsBackendOverride) {
			throw new VoiceStartupError(
				"invalid-options",
				"[voice] backendOverride and ttsBackendOverride are mutually exclusive.",
			);
		}
		if (opts.backendOverride && opts.useFfiBackend) {
			throw new VoiceStartupError(
				"missing-fused-build",
				"[voice] backendOverride cannot be combined with useFfiBackend=true. Voice-on production paths must load libelizainference and verify its ABI instead of bypassing the fused runtime.",
			);
		}
		if (opts.backendOverride) {
			backend = opts.backendOverride;
		} else if (opts.useFfiBackend) {
			const libPath = locateBundleLibrary(opts.bundleRoot);
			if (!existsSync(libPath)) {
				throw new VoiceStartupError(
					"missing-ffi",
					`[voice] Fused omnivoice library not found under ${path.join(opts.bundleRoot, "lib")} (tried ${libraryFilenames().join(", ")}). Build via packages/app-core/scripts/build-llama-cpp-mtp.mjs (omnivoice-fuse target).`,
				);
			}
			ffiHandle = loadElizaInferenceFfi(libPath);
			const contextRef: FfiContextRef = {
				current: null,
				ensure: () => {
					if (!ffiHandle) {
						throw new VoiceStartupError(
							"missing-ffi",
							"[voice] FFI context requested without a loaded libelizainference handle",
						);
					}
					if (contextRef.current === null) {
						contextRef.current = ffiHandle.create(opts.bundleRoot);
					}
					return contextRef.current;
				},
			};
			ffiContextRef = contextRef;
			backend =
				opts.ttsBackendOverride ??
				new FfiOmniVoiceBackend({
					ffi: ffiHandle,
					getContext: contextRef.ensure,
					sampleRate,
				});
		} else {
			backend = opts.ttsBackendOverride ?? new StubTtsBackend(sampleRate);
		}

		const config: SchedulerConfig = {
			chunkerConfig: {
				maxTokensPerPhrase:
					opts.maxTokensPerPhrase ??
					readPositiveIntEnv("ELIZA_VOICE_MAX_TOKENS_PER_PHRASE") ??
					PHRASE_MAX_TOKENS_DEFAULT,
			},
			preset: schedulerPreset,
			ringBufferCapacity:
				opts.ringBufferCapacity ?? RING_BUFFER_CAPACITY_DEFAULT,
			sampleRate,
			maxInFlightPhrases:
				opts.maxInFlightPhrases ??
				readPositiveIntEnv("ELIZA_VOICE_MAX_IN_FLIGHT_PHRASES"),
		};

		const sinkOverride = opts.sink;
		let selfVoiceImprint: AgentSelfVoiceImprint | null = null;
		const schedulerEvents: SchedulerEvents = {
			...(opts.events ?? {}),
			onAudio(chunk) {
				opts.events?.onAudio?.(chunk);
				if (!selfVoiceImprint) return;
				void selfVoiceImprint
					.observeAudio(chunk.pcm, chunk.sampleRate)
					.catch((err: unknown) => {
						logger.warn(
							{
								error: err instanceof Error ? err.message : String(err),
							},
							"[voice-bridge] agent self-voice imprint update failed",
						);
					});
			},
		};
		const scheduler = new VoiceScheduler(
			config,
			sinkOverride
				? { backend, sink: sinkOverride, phraseCache }
				: { backend, phraseCache },
			schedulerEvents,
		);

		// Wire the voice lifecycle. The lifecycle starts in `voice-off` —
		// heavy resources (TTS + ASR mmap regions) are loaded only when
		// `arm()` is called. The default loaders derive an mmap-style
		// handle from the bundle's `tts/` and `asr/` directories so that
		// production paths get real eviction calls; tests inject
		// `lifecycleLoaders` to assert the disarm path.
		const registry = opts.sharedResources ?? new SharedResourceRegistry();
		const loaders =
			opts.lifecycleLoaders ??
			defaultLifecycleLoaders(opts.bundleRoot, ffiHandle, ffiContextRef, {
				skipTtsRegion: Boolean(opts.ttsBackendOverride),
			});
		const lifecycle = new VoiceLifecycle({ registry, loaders });

		// Wire speaker-attribution when a profile store is provided. The
		// attribution pipeline wraps the fused encoder + diarizer + profile-store.
		// Both run through the ONE fused `libelizainference` handle via its
		// `eliza_inference_speaker_*` / `_diariz_*` ABI — there is no standalone
		// `libvoice_classifier` runtime. The speaker ABI is probed synchronously
		// here (`FusedSpeakerEncoder.isSupported`); the native session `load()`
		// runs lazily on first encode/diarize.
		//
		// Degradation contract (#12257): when the fused speaker runtime is
		// absent — no fused handle (e.g. the Kokoro-only TTS path) or a build
		// without the speaker ABI — keep voice working WITHOUT attribution and
		// warn exactly once. This is configured-absence, not silent error
		// recovery (loud-fail invariant): voice still runs and the operator is
		// told once, rather than crashing the session or attributing every turn
		// to "unknown speaker" behind their back.
		let attributionPipeline: VoiceAttributionPipeline | null = null;
		if (opts.profileStore) {
			const fusedFfi = ffiHandle;
			const fusedCtx = ffiContextRef;
			if (!fusedFfi || !fusedCtx) {
				warnSpeakerAttributionUnavailableOnce(
					"the fused libelizainference handle is absent (useFfiBackend=false); no standalone speaker runtime exists",
				);
			} else if (!FusedSpeakerEncoder.isSupported(fusedFfi)) {
				warnSpeakerAttributionUnavailableOnce(
					"the loaded libelizainference build lacks the speaker ABI (eliza_inference_speaker_supported() == 0); rebuild with the WeSpeaker forward graph linked in (eliza_inference_speaker_* symbols)",
				);
			} else {
				// Fused encoder: probe passed above; the native session opens lazily
				// on first encode() so voice-off does not keep the model resident.
				let resolvedEncoder: SpeakerEncoder | null = null;
				let encoderLoadError: Error | null = null;
				const lazyEncoder: SpeakerEncoder = {
					embeddingDim: SPEAKER_GGML_EMBEDDING_DIM,
					sampleRate: SPEAKER_GGML_SAMPLE_RATE,
					async encode(pcm: Float32Array): Promise<Float32Array> {
						if (encoderLoadError) throw encoderLoadError;
						if (!resolvedEncoder) {
							try {
								resolvedEncoder = await FusedSpeakerEncoder.load({
									ffi: fusedFfi,
									ctx: () => fusedCtx.ensure(),
								});
							} catch (err) {
								encoderLoadError =
									err instanceof Error ? err : new Error(String(err));
								throw encoderLoadError;
							}
						}
						return resolvedEncoder.encode(pcm);
					},
					async dispose(): Promise<void> {
						await resolvedEncoder?.dispose();
					},
				};
				selfVoiceImprint = new AgentSelfVoiceImprint({
					encoder: lazyEncoder,
				});
				// #12255's speaker-gated barge-in reads the live imprint through the
				// shared handle (getAgentSelfVoiceImprint) — the speak-back loop's
				// registration takes precedence over Pipeline A's.
				registerAgentSelfVoiceImprint("speak-back-loop", selfVoiceImprint);
				// Fused diarizer (optional). When the build does not advertise the
				// diarizer ABI, attribution runs without it — a single-speaker turn
				// collapses to one segment (the attribution-pipeline localSpeakerId=0
				// path). The diarizer is NOT a fail-fast gate (unlike the encoder):
				// it refines multi-speaker windows, it is not required to attribute a
				// single speaker.
				let lazyDiarizer: Diarizer | undefined;
				if (FusedDiarizer.isSupported(fusedFfi)) {
					let resolvedDiarizer: Diarizer | null = null;
					let diarizerLoadError: Error | null = null;
					lazyDiarizer = {
						modelId: PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
						sampleRate: SPEAKER_GGML_SAMPLE_RATE,
						async diarizeWindow(pcm: Float32Array) {
							if (diarizerLoadError) throw diarizerLoadError;
							if (!resolvedDiarizer) {
								try {
									resolvedDiarizer = await FusedDiarizer.load({
										ffi: fusedFfi,
										ctx: () => fusedCtx.ensure(),
									});
								} catch (err) {
									diarizerLoadError =
										err instanceof Error ? err : new Error(String(err));
									throw diarizerLoadError;
								}
							}
							return resolvedDiarizer.diarizeWindow(pcm);
						},
						async dispose(): Promise<void> {
							await resolvedDiarizer?.dispose();
						},
					};
				}
				attributionPipeline = new VoiceAttributionPipeline({
					encoder: lazyEncoder,
					...(lazyDiarizer ? { diarizer: lazyDiarizer } : {}),
					profileStore: opts.profileStore,
					// Surface the detached speech-start speculative match's failures into
					// the runtime error stream when a full runtime is present (#12894 J7).
					...(isEventRuntime(opts.runtime)
						? { reportError: opts.runtime.reportError.bind(opts.runtime) }
						: {}),
				});
			}
		}

		// W3-9 / F1 — construct the cancellation coordinator + optimistic policy
		// when a runtime is supplied. The coordinator's ttsStop callback closes
		// over `bridge.triggerBargeIn()`, which is wired below once the bridge
		// is constructed.
		const wiring = buildCancellationWiring(opts);

		const bridge = new EngineVoiceBridge(
			scheduler,
			backend,
			opts.bundleRoot,
			lifecycle,
			ffiHandle,
			ffiContextRef,
			asrAvailable,
			phraseCache,
			attributionPipeline,
			selfVoiceImprint,
			wiring?.coordinator ?? null,
			wiring?.policy ?? null,
			isEventRuntime(opts.runtime) ? opts.runtime : null,
			opts.liveAttribution ?? null,
		);
		if (wiring) wiring.bindTtsStop(() => bridge.triggerBargeIn());
		return bridge;
	}

	/**
	 * Kokoro-only path. Skips bundle-root / speaker-preset / FFI checks
	 * (Kokoro picks voices by id against `KOKORO_VOICE_PACKS`) and
	 * synthesizes a minimal `SpeakerPreset` keyed to the discovered voice
	 * id. Defaults lifecycle loaders to empty handles since ORT owns the
	 * model memory. `asrAvailable` is `false`: callers needing ASR
	 * construct `createStreamingTranscriber` directly.
	 */
	private static startKokoroOnly(
		opts: EngineVoiceBridgeOptions,
	): EngineVoiceBridge {
		if (!opts.kokoroOnly) {
			throw new VoiceStartupError(
				"invalid-options",
				"[voice] startKokoroOnly called without `kokoroOnly` config — this is an internal error.",
			);
		}
		const kokoro = opts.kokoroOnly;
		const sampleRate = opts.sampleRate ?? kokoro.layout.sampleRate;
		const workDir =
			opts.bundleRoot && existsSync(opts.bundleRoot)
				? opts.bundleRoot
				: localInferenceRoot();

		// Synthesize a minimal preset. Kokoro's `resolveVoice(preset)` looks
		// up `preset.voiceId` against `KOKORO_VOICE_PACKS`; the embedding +
		// bytes fields are ignored on this path (voice cloning is OmniVoice-only).
		const preset = createKokoroSpeakerPreset(kokoro);

		// Anchor the in-process Kokoro FFI ctx at the Eliza-1 bundle root when
		// one is present; otherwise the runtime anchors at the Kokoro model root.
		const backend = createKokoroTtsBackend(kokoro, {
			bundleRoot:
				opts.bundleRoot && existsSync(opts.bundleRoot)
					? opts.bundleRoot
					: undefined,
			...(opts.kokoroFfi ? { ffi: opts.kokoroFfi } : {}),
		});

		const phraseCache = new PhraseCache();
		for (const entry of opts.prewarmedPhrases ?? []) {
			phraseCache.put(entry);
		}

		const config: SchedulerConfig = {
			chunkerConfig: {
				maxTokensPerPhrase:
					opts.maxTokensPerPhrase ??
					readPositiveIntEnv("ELIZA_VOICE_MAX_TOKENS_PER_PHRASE") ??
					PHRASE_MAX_TOKENS_DEFAULT,
			},
			preset,
			ringBufferCapacity:
				opts.ringBufferCapacity ?? RING_BUFFER_CAPACITY_DEFAULT,
			sampleRate,
			maxInFlightPhrases:
				opts.maxInFlightPhrases ??
				readPositiveIntEnv("ELIZA_VOICE_MAX_IN_FLIGHT_PHRASES"),
		};

		const sinkOverride = opts.sink;
		const scheduler = new VoiceScheduler(
			config,
			sinkOverride
				? { backend, sink: sinkOverride, phraseCache }
				: { backend, phraseCache },
			opts.events ?? {},
		);

		const registry = opts.sharedResources ?? new SharedResourceRegistry();
		const loaders = opts.lifecycleLoaders ?? kokoroOnlyLifecycleLoaders();
		const lifecycle = new VoiceLifecycle({ registry, loaders });

		const wiring = buildCancellationWiring(opts);

		const bridge = new EngineVoiceBridge(
			scheduler,
			backend,
			workDir,
			lifecycle,
			null, // no FFI handle on Kokoro-only
			null, // no FFI context on Kokoro-only
			false, // ASR is not served from this path
			phraseCache,
			null, // no profile store on Kokoro-only
			null, // no self-voice imprint without live attribution
			wiring?.coordinator ?? null,
			wiring?.policy ?? null,
		);
		if (wiring) wiring.bindTtsStop(() => bridge.triggerBargeIn());
		return bridge;
	}

	/**
	 * True when this bridge runs against a TTS backend that produces real
	 * audio — i.e. anything but the `StubTtsBackend` (which yields
	 * zeros and is tests-only). The prewarm + first-audio-filler paths gate
	 * on this so the cache never holds silence (AGENTS.md §3 — no fake data).
	 */
	hasRealTtsBackend(): boolean {
		return !(this.backend instanceof StubTtsBackend);
	}

	/**
	 * Lazy-load the TTS mmap region, optional ASR region, and the voice
	 * scheduler nodes via the lifecycle state machine. Idempotent for
	 * repeated calls in `voice-on` (returns the existing armed resources).
	 * Surfaces RAM pressure / mmap-fail / kernel-missing as `VoiceLifecycleError` —
	 * see `lifecycle.ts` for the full error taxonomy.
	 */
	async arm(): Promise<void> {
		if (this.lifecycle.current().kind === "voice-on") return;
		await this.lifecycle.arm();
	}

	/**
	 * Drain in-flight TTS, settle the scheduler, then disarm the
	 * lifecycle. Disarm calls `evictPages()` (madvise / VirtualUnlock
	 * equivalent) on the TTS + optional ASR mmap regions and releases every
	 * voice-only ref. Speaker preset + phrase cache survive in the
	 * registry as small LRU entries (KB-scale; not worth evicting).
	 */
	async disarm(): Promise<void> {
		if (this.lifecycle.current().kind !== "voice-on") return;
		await this.settle();
		await this.lifecycle.disarm();
	}

	/**
	 * Forward an accepted text token from the verifier into the scheduler.
	 * Tokens that fill a phrase trigger TTS dispatch on the same scheduler
	 * tick (AGENTS.md §4 — no buffering past phrase boundaries).
	 */
	async pushAcceptedToken(
		token: TextToken,
		acceptedAt = Date.now(),
	): Promise<void> {
		await this.scheduler.accept(token, acceptedAt);
	}

	/**
	 * MTP rejection → rollback queue. The scheduler cancels any
	 * in-flight TTS forward pass for phrases that overlap the rejected
	 * token range and emits an `onRollback` event for observability.
	 * Already-played audio cannot be unplayed; the chunker is sized so
	 * rollback is rare and cheap.
	 */
	async pushRejectedRange(range: RejectedTokenRange): Promise<void> {
		await this.scheduler.reject(range);
	}

	/**
	 * Voice activity detected on the mic input → cancel everything.
	 * Drains the ring buffer immediately, flushes the chunker queue, and
	 * marks every in-flight cancel signal so synthesise loops exit at the
	 * next kernel boundary (AGENTS.md §4 — barge-in cancellation MUST be
	 * within one kernel tick).
	 */
	triggerBargeIn(): void {
		// Cancel the text side first (stop ASR / drafter / verifier at the next
		// kernel boundary), then the audio side (ring-buffer drain + chunker
		// flush + in-flight TTS cancel). The pipeline also wires its own
		// barge-in listener onto the scheduler, so `onMicActive()` alone would
		// suffice — calling `cancel()` first just stops the next HTTP body
		// sooner.
		this.activePipeline?.cancel();
		this.scheduler.bargeIn.onMicActive();
	}

	/**
	 * W3-9 / F1 — the canonical voice cancellation coordinator for this
	 * session, or `null` when the bridge was constructed without a
	 * `runtime` option. Callers (turn controller, mic VAD source, UI cancel
	 * route) use this to arm per-turn tokens, fire `bargeIn(roomId)` on
	 * VAD speech-start, fire `revokeEot(roomId)` when the turn detector
	 * revokes a tentative EOT, etc. See
	 * `plugins/plugin-local-inference/docs/voice-cancellation-contract.md`.
	 */
	cancellationCoordinatorOrNull(): VoiceCancellationCoordinator | null {
		return this.cancellationCoordinator;
	}

	/**
	 * W3-9 / F1 — the optimistic-generation policy for this session, or
	 * `null` when the bridge was constructed without a `runtime` option.
	 * The bridge primes it with the resolved power source at construction
	 * time; callers can mutate it via `setPowerSource()` / `setOverride()`
	 * to respond to Settings toggles or battery-state events.
	 */
	optimisticPolicyOrNull(): OptimisticGenerationPolicy | null {
		return this.optimisticGenerationPolicy;
	}

	/**
	 * W3-9 / F1 — bind the scheduler's `BargeInController` into the
	 * cancellation coordinator for `roomId`. Subsequent
	 * `BargeInController.hardStop()` calls (typically fired by the
	 * ASR-confirmed barge-in words ladder) translate into
	 * `coordinator.bargeIn(roomId)` so the canonical token (and every
	 * downstream consumer: runtime turn abort, LM slot abort, TTS stop,
	 * AbortSignal) sees the abort.
	 *
	 * Idempotent per `roomId` — repeated calls for the same room return
	 * the same unsubscribe handle (the prior binding is torn down first).
	 *
	 * When the bridge was constructed without a `runtime` option, this returns
	 * an empty unsubscribe. Callers should still call it
	 * unconditionally — back-compat for the legacy path is automatic.
	 */
	bindBargeInControllerForRoom(roomId: string): () => void {
		if (!this.cancellationCoordinator) {
			return () => undefined;
		}
		const existing = this.bargeInBindings.get(roomId);
		if (existing) existing();
		const unsub = this.cancellationCoordinator.bindBargeInController(
			roomId,
			this.scheduler.bargeIn,
		);
		this.bargeInBindings.set(roomId, unsub);
		return () => {
			unsub();
			if (this.bargeInBindings.get(roomId) === unsub) {
				this.bargeInBindings.delete(roomId);
			}
		};
	}

	/**
	 * Drain pending phrase data and wait for in-flight TTS to settle.
	 * Used at the end of a turn so callers can synchronise on a quiescent
	 * scheduler before they tear it down.
	 */
	async settle(): Promise<void> {
		await this.scheduler.flushPending();
		await this.scheduler.waitIdle();
	}

	async synthesizeTextToWav(
		text: string,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		this.assertVoiceOn("synthesize speech");
		if (!this.hasRealTtsBackend()) {
			throw new VoiceStartupError(
				"missing-fused-build",
				"[voice] Direct speech synthesis requires a fused OmniVoice backend. The deterministic test backend is only allowed in scheduler/unit tests.",
			);
		}
		const chunk = await this.scheduler.synthesizeText(text, signal);
		return encodeMonoPcm16Wav(chunk.pcm, chunk.sampleRate);
	}

	/**
	 * The streaming-TTS seam W9's scheduler drives: returns the active
	 * backend as a `StreamingTtsBackend` (`FfiOmniVoiceBackend` against the
	 * fused build, `StubTtsBackend` for tests). The scheduler calls
	 * `synthesizeStream(...)` for each phrase and writes the delivered PCM
	 * segments into its `PcmRingBuffer` on the same scheduler tick. Returns
	 * null when an injected `backendOverride` does not implement the seam.
	 */
	streamingTtsBackend(): StreamingTtsBackend | null {
		return isStreamingTtsBackend(this.backend) ? this.backend : null;
	}

	/**
	 * True when the loaded fused `libelizainference` runs the MTP
	 * speculative loop in-process and can emit native accept/reject
	 * verifier events. When true, callers (W9's turn controller /
	 * `ffi-streaming-backend.ts` wiring) should subscribe via
	 * `subscribeNativeVerifier()` and SKIP the `llama-server` SSE
	 * `{"verifier":{"rejected":[a,b]}}` side-channel — the SSE path stays
	 * only as the non-fused desktop text fallback. False whenever there is
	 * no FFI handle or the build pre-dates the verifier callback.
	 */
	hasNativeVerifier(): boolean {
		// ABI v3 exports `eliza_inference_set_verifier_callback`, but the
		// current generated adapter returns ELIZA_ERR_NOT_IMPLEMENTED until the
		// native MTP speculative loop is ported into libelizainference. Do
		// not let callers skip the SSE verifier fallback merely because the
		// symbol exists.
		return false;
	}

	/**
	 * Register the native MTP verifier callback on the fused runtime
	 * and adapt each `NativeVerifierEvent` into the rollback-queue domain:
	 * accepted/corrected token-id ranges become `VerifierStreamEvent`s and
	 * rejected ranges become `RejectedTokenRange`s fed to `pushRejectedRange`.
	 * The returned handle MUST be `close()`d (clears the native callback +
	 * frees the bun:ffi `JSCallback`). Throws if no fused runtime is loaded.
	 *
	 * `onEvent` (optional) also receives the raw `NativeVerifierEvent` for
	 * callers that want the accepted-token stream (W9's phrase-chunker can
	 * commit accepted draft tokens directly off this instead of round-trip
	 * SSE deltas).
	 */
	subscribeNativeVerifier(onEvent?: (event: NativeVerifierEvent) => void): {
		close(): void;
	} {
		if (!this.ffi) {
			throw new VoiceStartupError(
				"missing-ffi",
				"[voice] subscribeNativeVerifier requires a loaded fused libelizainference handle",
			);
		}
		const ctx = this.ffiContextRef
			? this.ffiContextRef.ensure()
			: (() => {
					throw new VoiceStartupError(
						"missing-ffi",
						"[voice] subscribeNativeVerifier: no FFI context provider",
					);
				})();
		return this.ffi.setVerifierCallback(ctx, (event) => {
			onEvent?.(event);
			const rollback = nativeRejectedRangeToRollbackRange(event);
			if (rollback) {
				void this.pushRejectedRange(rollback);
			}
		});
	}

	async prewarmPhrases(
		texts: ReadonlyArray<string>,
		opts: { concurrency?: number } = {},
	): Promise<{ warmed: number; cached: number }> {
		this.assertVoiceOn("prewarm voice phrases");
		return this.scheduler.prewarmPhrases(texts, opts);
	}

	/**
	 * Idle-time auto-prewarm hook: synthesize the canonical phrase-cache seed
	 * (`DEFAULT_PHRASE_CACHE_SEED`) so common openers/acks are cached before
	 * the next turn. The voice bridge / connector calls this when the loop is
	 * idle. No-op (returns `{ warmed: 0, cached: 0 }`) unless a real TTS
	 * backend is present and voice is armed — we never cache the test backend's zeros
	 * (AGENTS.md §3).
	 */
	async prewarmIdlePhrases(
		opts: { concurrency?: number } = {},
	): Promise<{ warmed: number; cached: number }> {
		if (!this.hasRealTtsBackend()) return { warmed: 0, cached: 0 };
		if (this.lifecycle.current().kind !== "voice-on") {
			return { warmed: 0, cached: 0 };
		}
		return this.scheduler.prewarmPhrases(DEFAULT_PHRASE_CACHE_SEED, opts);
	}

	/**
	 * First-audio filler (AGENTS.md §4 / H4): the instant W1's VAD fires
	 * `speech-start`, play a short cached acknowledgement ("one sec", "okay",
	 * …) into the audio sink to mask first-token latency. W9's turn controller
	 * owns the call site (it gets the `speech-start` event and the cutover to
	 * real `replyText` audio); this method is the seam.
	 *
	 * It only ever plays audio that is *already in the phrase cache* — it does
	 * not synthesize. Returns the filler text that was played, or `null` if no
	 * filler was played (no real TTS backend, voice not armed, or none of the
	 * filler phrases are cached). When real reply audio is ready, W9 cuts over
	 * by writing it through the scheduler as usual (a `triggerBargeIn()` or a
	 * direct `ringBuffer.drain()` truncates any still-playing filler first).
	 */
	playFirstAudioFiller(): string | null {
		if (!this.hasRealTtsBackend()) return null;
		if (this.lifecycle.current().kind !== "voice-on") return null;
		for (const text of FIRST_AUDIO_FILLERS) {
			const cached = this.phraseCache.get(text);
			if (!cached || cached.pcm.length === 0) continue;
			this.scheduler.ringBuffer.write(cached.pcm);
			const flushed = this.scheduler.ringBuffer.flushToSink();
			this.scheduler.markAgentSpeakingForAudio(flushed, cached.sampleRate);
			return cached.text;
		}
		return null;
	}

	/**
	 * Construct a `StreamingTranscriber` for live ASR — the contract the
	 * voice turn controller (W9) feeds mic frames into and the barge-in
	 * word-confirm gate (W1) listens to. The drive mode is picked by
	 * `pickStreamingMode` (#12254): the fused streaming decoder when the
	 * loaded build advertises one, the ASR bundle is present, and
	 * `ELIZA_VOICE_STREAMING_ASR` is not disabled (default on) — else the
	 * interim windowed-batch adapter, announced at INFO. In streaming mode
	 * the transcriber is wrapped in `StabilizedStreamingTranscriber`
	 * (word-level LocalAgreement-2) so subscribers only ever see a
	 * monotonic committed prefix. No fused decoder at all →
	 * `AsrUnavailableError`; the whisper.cpp fallback has been removed.
	 *
	 * Pass W1's `vad` event stream to gate decoding to active speech
	 * windows. Caller owns the returned transcriber's lifecycle (`dispose()`).
	 */
	createStreamingTranscriber(opts?: {
		vad?: VadEventSource;
	}): StreamingTranscriber {
		this.assertVoiceOn("create streaming transcriber");
		return this.constructTranscriber(opts);
	}

	/** Last ASR drive mode announced, so the pick is logged once per change. */
	private loggedAsrDriveMode: StreamingPipelineMode | null = null;

	/**
	 * Shared transcriber construction (mode pick + loud announcement +
	 * streaming-partial stabilization). `createStreamingTranscriber` adds the
	 * voice-on assertion; `resolveTranscriber` adds the deferred-failure
	 * wrapper for the pipeline path.
	 */
	private constructTranscriber(opts?: {
		vad?: VadEventSource;
	}): StreamingTranscriber {
		const contextRef = this.ffiContextRef;
		// An explicit ELIZA_LOCAL_ASR_BACKEND pin wins over the capability
		// gate; otherwise streaming is picked exactly when supported + present
		// + not disabled by ELIZA_VOICE_STREAMING_ASR.
		const envPrefer = readAsrBackendPreferenceFromEnv();
		const mode: StreamingPipelineMode =
			envPrefer === "fused"
				? "streaming"
				: envPrefer === "ffi-batch"
					? "batch"
					: pickStreamingMode({
							ffiSupportsStreaming: ffiSupportsStreamingAsr(this.ffi),
							asrBundlePresent: this.asrAvailable,
							enableStreaming: readStreamingAsrEnabledFromEnv(),
						});
		if (this.loggedAsrDriveMode !== mode) {
			this.loggedAsrDriveMode = mode;
			if (mode === "streaming") {
				logger.info(
					"[EngineVoiceBridge] ASR drive mode: streaming — fused eliza_inference_asr_stream_* decoder with LocalAgreement-2 partial stabilization",
				);
			} else {
				logger.info(
					`[EngineVoiceBridge] ASR drive mode: batch — fused streaming decoder ${
						ffiSupportsStreamingAsr(this.ffi)
							? "disabled (ELIZA_VOICE_STREAMING_ASR/ELIZA_LOCAL_ASR_BACKEND)"
							: "unavailable on this build (asrStreamSupported() == 0)"
					}; interim windowed re-transcription at stepSeconds=${readAsrStepSecondsFromEnv() ?? DEFAULT_ASR_STEP_SECONDS}`,
				);
			}
		}
		const transcriber = createStreamingTranscriber({
			ffi: this.ffi,
			getContext: contextRef ? () => contextRef.ensure() : undefined,
			asrBundlePresent: this.asrAvailable,
			vad: opts?.vad,
			prefer: mode === "streaming" ? "fused" : "ffi-batch",
		});
		return mode === "streaming"
			? new StabilizedStreamingTranscriber(transcriber)
			: transcriber;
	}

	/**
	 * Batch transcription: one-shot over a whole PCM buffer. When the active
	 * backend exposes the fused batch ASR ABI, use it directly so the native
	 * side receives the original sample rate and can apply its own resampling.
	 * Otherwise drive a `StreamingTranscriber` (fused streaming ASR →
	 * fused-batch interim) by feeding the buffer as a single frame and
	 * `flush()`ing. Throws `AsrUnavailableError` when no ASR backend is
	 * available — never a silent empty string.
	 */
	/** Transcribe + per-word timings through the fused ASR (v12). Prefers the
	 *  backend's timed path; falls back to the plain transcript with empty
	 *  `words` when timing isn't available. */
	async transcribePcmTimed(
		args: TranscriptionAudio,
		signal?: AbortSignal,
	): Promise<{ text: string; words: AsrWordTiming[] }> {
		this.assertVoiceOn("transcribe audio");
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		const backendTimed = this.backend as TtsBackend & {
			transcribeTimed?: (
				args: TranscriptionAudio,
			) => Promise<{ text: string; words: AsrWordTiming[] }>;
		};
		if (typeof backendTimed.transcribeTimed === "function") {
			const result = await backendTimed.transcribeTimed(args);
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			return result;
		}
		if (
			this.ffi &&
			this.ffiContextRef &&
			this.asrAvailable &&
			this.ffi.timedAsrSupported()
		) {
			const pcm =
				args.sampleRate === ASR_SAMPLE_RATE
					? args.pcm
					: resampleLinear(args.pcm, args.sampleRate, ASR_SAMPLE_RATE);
			const res = this.ffi.asrTranscribeTimed({
				ctx: this.ffiContextRef.ensure(),
				pcm,
				sampleRateHz: ASR_SAMPLE_RATE,
			});
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			return { text: res.text.trim(), words: res.words };
		}
		// No timed path available — degrade to the text-only transcript.
		logger.debug(
			"[EngineVoiceBridge] timedAsrSupported()===false on the active fused build — per-word timings dropped, transcript player degrades to segment-level highlight",
		);
		return { text: await this.transcribePcm(args, signal), words: [] };
	}

	async transcribePcm(
		args: TranscriptionAudio,
		signal?: AbortSignal,
		onPartial?: (delta: string) => void,
	): Promise<string> {
		this.assertVoiceOn("transcribe audio");
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		// Streaming path: when the caller wants partial transcripts (the
		// TRANSCRIPTION model handler forwards the runtime's onStreamChunk here),
		// drive the fused streaming-ASR session and emit each running partial as a
		// delta — the same per-token pipe as chat text. Feed in ~1s windows so the
		// decode surfaces partials progressively. Degrades gracefully: when the
		// fused build's streaming-ASR decoder is a stub, createStreamingTranscriber
		// resolves the fused batch adapter and the final transcript is emitted once.
		if (onPartial) {
			const transcriber = this.createStreamingTranscriber();
			let shown = 0;
			const emit = (full: string): void => {
				if (typeof full === "string" && full.length > shown) {
					const delta = full.slice(shown);
					shown = full.length;
					onPartial(delta);
				}
			};
			const unsub = transcriber.on((ev) => {
				if (ev.kind === "partial" || ev.kind === "final") {
					emit(ev.update.partial);
				}
			});
			const abort = () => transcriber.dispose();
			try {
				signal?.addEventListener("abort", abort, { once: true });
				const win = Math.max(1600, Math.round(args.sampleRate));
				for (let off = 0; off < args.pcm.length; off += win) {
					if (signal?.aborted) break;
					transcriber.feed({
						pcm: args.pcm.subarray(off, Math.min(off + win, args.pcm.length)),
						sampleRate: args.sampleRate,
						timestampMs: Math.round((off / args.sampleRate) * 1000),
					});
				}
				const final = await transcriber.flush();
				emit(final.partial);
				if (signal?.aborted) {
					throw signal.reason instanceof Error
						? signal.reason
						: new DOMException("Aborted", "AbortError");
				}
				return final.partial;
			} finally {
				unsub();
				signal?.removeEventListener("abort", abort);
				transcriber.dispose();
			}
		}
		const backendBatch = this.backend as TtsBackend & {
			transcribe?: (args: TranscriptionAudio) => Promise<string>;
		};
		if (typeof backendBatch.transcribe === "function") {
			const transcript = await backendBatch.transcribe(args);
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			return transcript;
		}
		if (
			this.ffi &&
			this.ffiContextRef &&
			this.asrAvailable &&
			typeof this.ffi.asrTranscribe === "function"
		) {
			const pcm =
				args.sampleRate === ASR_SAMPLE_RATE
					? args.pcm
					: resampleLinear(args.pcm, args.sampleRate, ASR_SAMPLE_RATE);
			const transcript = this.ffi
				.asrTranscribe({
					ctx: this.ffiContextRef.ensure(),
					pcm,
					sampleRateHz: ASR_SAMPLE_RATE,
				})
				.trim();
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			return transcript;
		}
		const transcriber = this.createStreamingTranscriber();
		const abort = () => transcriber.dispose();
		try {
			signal?.addEventListener("abort", abort, { once: true });
			transcriber.feed({
				pcm: args.pcm,
				sampleRate: args.sampleRate,
				timestampMs: 0,
			});
			const final = await transcriber.flush();
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			return final.partial;
		} finally {
			signal?.removeEventListener("abort", abort);
			transcriber.dispose();
		}
	}

	/**
	 * Run one fused mic→speech turn through the overlapped `VoicePipeline`
	 * (AGENTS.md §4): ASR streams; the instant its last token lands the
	 * MTP drafter and the target verifier kick off concurrently, accepted
	 * tokens flow into this bridge's phrase chunker → TTS → ring buffer on
	 * the same tick, rejected draft tails roll back not-yet-spoken audio, and
	 * a mic-VAD barge-in cancels everything at the next kernel boundary.
	 *
	 * The drafter + verifier are wired against the running MTP llama-server
	 * (`textRunner`); the transcriber is the fused ABI's ASR when this bridge
	 * was started with the FFI backend and the bundle ships an `asr/` region.
	 * In voice mode a missing ASR region is a hard `VoiceStartupError` — no
	 * silent cloud fallback (AGENTS.md §3 + §7).
	 *
	 * Resolves with the turn's exit reason. Throws if no turn is wired or one
	 * is already in flight. The created pipeline is held until the turn ends
	 * so `bargeIn()` can cancel it.
	 */
	async runVoiceTurn(
		audio: TranscriptionAudio,
		textRunner: MtpTextRunner,
		config: VoicePipelineConfig,
		events?: VoiceTurnEvents,
	): Promise<"done" | "token-cap" | "cancelled"> {
		this.assertVoiceOn("run a voice turn");
		// The turn's ASR transcript materializes inside `pipeline.run` (the
		// `onAsrComplete` event) while attribution runs in parallel, so the two
		// have to be correlated. `transcriptReady` resolves with the joined ASR
		// text the instant ASR finalizes; the attribution `.then` awaits it before
		// emitting `VOICE_TURN_OBSERVED` so the merge engine sees *what* was said,
		// not just *who* said it (#8786). The pipeline's `finally` resolves it with
		// the captured text (or "") so a cancelled/no-ASR turn never hangs the await.
		let asrTranscript = "";
		let resolveTranscript: (text: string) => void = () => {};
		const transcriptReady = new Promise<string>((resolve) => {
			resolveTranscript = resolve;
		});
		const turnEvents: VoiceTurnEvents = {
			...events,
			onAsrComplete(tokens) {
				asrTranscript = tokens.map((t) => t.text).join("");
				resolveTranscript(asrTranscript);
				events?.onAsrComplete?.(tokens);
			},
		};
		// If a profileStore was wired, kick off speaker-attribution in parallel
		// with ASR. The attribution uses the same PCM buffer as the transcriber
		// but runs through the diarizer + encoder + profile-store independently.
		// It is fire-and-forget from the pipeline's perspective: the result
		// arrives via `onAttribution` asynchronously (possibly after onComplete).
		if (
			this.attributionPipeline &&
			(turnEvents.onAttribution || this.eventRuntime)
		) {
			const onAttribution = turnEvents.onAttribution;
			const attribution = this.attributionPipeline;
			const eventRuntime = this.eventRuntime;
			const liveAttribution = this.liveAttribution;
			const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			void attribution
				.attribute({
					turnId,
					pcm: audio.pcm,
				})
				.then(async (output) => {
					// Automatic seam: when a full runtime is wired, emit
					// VOICE_TURN_OBSERVED and fold the speaker decision into the
					// turn's voiceTurnSignal BEFORE handing the (now-stamped)
					// output to the caller. Any caller with a profileStore +
					// runtime gets diarization-driven gating for free.
					if (eventRuntime) {
						const transcript = await transcriptReady;
						const { handleLiveVoiceAttribution } = await import(
							"../../runtime/voice-entity-binding.js"
						);
						const selfVoiceSimilarity =
							output.observation?.embedding && this.selfVoiceImprint
								? await this.selfVoiceImprint.similarity(
										output.observation.embedding,
									)
								: null;
						await handleLiveVoiceAttribution(eventRuntime, output, {
							...resolveLiveAttributionOptions(liveAttribution, transcript),
							agentSpeaking: this.scheduler.bargeIn.isAgentSpeaking,
							// The imprint's cosine is on the WeSpeaker-embedding scale —
							// its own threshold (~0.28) travels with it so the fold does
							// not compare it against the 0.7 MFCC bar (#12256).
							...(typeof selfVoiceSimilarity === "number" &&
							this.selfVoiceImprint
								? {
										selfVoiceSimilarity,
										selfVoiceThreshold: this.selfVoiceImprint.threshold,
									}
								: {}),
						});
					}
					onAttribution?.(output);
				})
				.catch((err: unknown) => {
					// Attribution failures must not crash the turn. Log and continue.
					logger.warn(
						{
							turnId,
							error: err instanceof Error ? err.message : String(err),
						},
						"[voice-bridge] speaker attribution failed",
					);
				});
		}
		const pipeline = this.buildPipeline(textRunner, config, turnEvents);
		this.activePipeline = pipeline;
		try {
			return await pipeline.run(audio);
		} finally {
			// Settle the transcript promise so a cancelled/no-ASR turn (where
			// `onAsrComplete` never fired) cannot leave the attribution await pending.
			resolveTranscript(asrTranscript);
			if (this.activePipeline === pipeline) this.activePipeline = null;
		}
	}

	/** Construct the `VoicePipeline` for this bridge (no-run). Exposed for tests. */
	buildPipeline(
		textRunner: MtpTextRunner,
		config: VoicePipelineConfig,
		events?: VoicePipelineEvents,
	): VoicePipeline {
		const transcriber = this.resolveTranscriber();
		// Per-turn TTS transient reservation (#12254): sized to the measured
		// decode peak of the backend actually wired. Backends without a
		// measured table entry (test stubs/overrides) carry no reservation.
		const ttsTransientBytes =
			this.backend instanceof FfiOmniVoiceBackend
				? OMNIVOICE_TTS_TRANSIENT_PEAK_BYTES
				: this.backend instanceof KokoroTtsBackend
					? KOKORO_TTS_TRANSIENT_PEAK_BYTES
					: null;
		const deps: VoicePipelineDeps = {
			scheduler: this.scheduler,
			transcriber,
			drafter: new MtpDraftProposer(textRunner),
			verifier: new MtpTargetVerifier(textRunner),
			...(ttsTransientBytes !== null
				? { ttsTransientReservation: { bytes: ttsTransientBytes } }
				: {}),
		};
		return new VoicePipeline(deps, config, events);
	}

	/**
	 * Resolve the pipeline's ASR backend: a live `StreamingTranscriber` —
	 * the fused `eliza_inference_asr_stream_*` decoder when the loaded build
	 * advertises one and the bundle ships an `asr/` region, else the fused
	 * batch ASR adapter. The `VoicePipeline` drives it as a batch
	 * (feed the whole utterance, `flush()`, split the transcript into
	 * tokens). When no ASR backend is available the failure is surfaced as a
	 * `MissingAsrTranscriber` that throws on first use — AGENTS.md §3, no
	 * silent cloud fallback.
	 */
	private resolveTranscriber(): StreamingTranscriber {
		try {
			return this.constructTranscriber();
		} catch (err) {
			if (err instanceof AsrUnavailableError) {
				return new MissingAsrTranscriber(err.message);
			}
			throw err;
		}
	}

	/** Diagnostic accessor — bundle root the bridge is wired against. */
	bundlePath(): string {
		return this.bundleRoot;
	}

	private assertVoiceOn(action: string): void {
		const state = this.lifecycle.current();
		if (state.kind === "voice-on") return;
		if (state.kind === "voice-error") {
			throw state.error;
		}
		throw new VoiceLifecycleError(
			"illegal-transition",
			`[voice] Cannot ${action} while lifecycle is ${state.kind}. Call armVoice() and wait for voice-on first.`,
		);
	}
}

// The mono PCM16 WAV codec lives in the dependency-light `wav-codec.ts` so
// corpus / fixture / test code can encode + decode WAV without dragging in this
// heavy module. Re-exported here for the existing callers.
export { decodeMonoPcm16Wav, encodeMonoPcm16Wav };

function readPositiveIntEnv(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Default lifecycle loaders derived from the bundle layout (per
 * AGENTS.md §2: `tts/omnivoice-<size>.gguf` + `asr/...`).
 *
 * When a live `ffi`/`ctx` pair is passed in, arming calls
 * `ffi.mmapAcquire(ctx, "tts" | "asr")` before the lifecycle can enter
 * `voice-on`, and the returned handles' `evictPages()` calls forward
 * to `ffi.mmapEvict(ctx, "tts" | "asr")`. The C ABI is declared in
 * `scripts/omnivoice-fuse/ffi.h`. Production builds may implement this
 * as page eviction or as a full voice-runtime unload for mobile RAM
 * pressure; callers must reacquire before using the region again. The
 * compatibility library returns `ELIZA_ERR_NOT_IMPLEMENTED`, which the binding raises as
 * `VoiceLifecycleError({code:"kernel-missing"})`.
 *
 * When `ffi` is null, acquire/evict are documented empty transitions — used by the
 * development TTS path in tests + dev (no real mmap exists). Directory and
 * "contains at least one file" checks still run for both TTS and ASR.
 * ASR never gets a virtual fallback: voice-on requires a real bundled ASR
 * model file so the FFI path can acquire the `"asr"` region and surface
 * the fused ABI's diagnostic if the runtime lacks the required region support.
 */
interface FfiContextRef {
	current: ElizaInferenceContextHandle | null;
	ensure(): ElizaInferenceContextHandle;
}

function ensureContext(
	ref: ElizaInferenceContextHandle | FfiContextRef | null,
): ElizaInferenceContextHandle | null {
	if (ref === null) return null;
	if (typeof ref === "object" && "ensure" in ref) return ref.ensure();
	return ref;
}

/**
 * No-op lifecycle loaders for the Kokoro-only bridge. ORT owns the
 * model memory; nothing to mmap-acquire or evict. ASR is not served
 * from this path — callers that need ASR construct
 * `createStreamingTranscriber` directly (the fused-only chain in
 * `transcriber.ts`: fused streaming → fused batch → AsrUnavailableError).
 */
function noopMmapRegion(id: string): MmapRegionHandle {
	return {
		id,
		path: "",
		sizeBytes: 0,
		async evictPages() {
			// Nothing to evict — ORT owns the model bytes.
		},
		async release() {
			// No mmap region to release.
		},
	};
}

function kokoroOnlyLifecycleLoaders(): VoiceLifecycleLoaders {
	return {
		loadTtsRegion: async () => noopMmapRegion("kokoro:tts"),
		loadAsrRegion: async () => noopMmapRegion("kokoro:asr"),
		loadVoiceCaches: async () => ({
			id: "kokoro:voice-caches",
			async release() {},
		}),
		loadVoiceSchedulerNodes: async () => ({
			id: "kokoro:voice-scheduler-nodes",
			async release() {},
		}),
	};
}

function defaultLifecycleLoaders(
	bundleRoot: string,
	ffi: ElizaInferenceFfi | null,
	ctx: ElizaInferenceContextHandle | FfiContextRef | null,
	options: { skipTtsRegion?: boolean } = {},
): VoiceLifecycleLoaders {
	return {
		loadTtsRegion: async () =>
			options.skipTtsRegion === true
				? noopMmapRegion(`tts-override:${bundleRoot}`)
				: bundleMmapRegion(path.join(bundleRoot, "tts"), "tts", ffi, ctx),
		loadAsrRegion: async () =>
			bundleMmapRegion(path.join(bundleRoot, "asr"), "asr", ffi, ctx),
		loadVoiceCaches: async () => ({
			id: `voice-caches:${bundleRoot}`,
			async release() {
				// Caches stay live in the SpeakerPresetCache + PhraseCache
				// singletons; the registry refcount is the only thing that
				// drops on disarm.
			},
		}),
		loadVoiceSchedulerNodes: async () => ({
			id: `voice-scheduler-nodes:${bundleRoot}`,
			async release() {
				// Scheduler nodes (chunker, rollback, ring buffer, barge-in)
				// are owned by the bridge's `scheduler` field — no extra
				// teardown beyond the refcount drop.
			},
		}),
	};
}

/**
 * Build an `MmapRegionHandle` for a bundle subdirectory. Refuses to
 * fabricate a region when the directory is missing — that surfaces as
 * `VoiceLifecycleError` via the lifecycle's `arm-failed`/`mmap-fail`
 * mapping (no silent fallback to a smaller voice model — AGENTS.md §3).
 *
 * `mmapAcquire()` / `evictPages()` forward to the FFI binding when one
 * is supplied. With no FFI handle (test mode), those calls return without
 * touching native memory because no real mmap was made. The lifecycle test
 * still asserts the call shape via injected mocks.
 */
function bundleMmapRegion(
	dir: string,
	kind: "tts" | "asr",
	ffi: ElizaInferenceFfi | null,
	ctx: ElizaInferenceContextHandle | FfiContextRef | null,
): MmapRegionHandle {
	if (!existsSync(dir)) {
		throw new Error(
			`[voice] mmap MAP_FAILED: ${kind} directory missing at ${dir}`,
		);
	}
	if (!directoryHasRegularFile(dir)) {
		throw new Error(
			`[voice] mmap MAP_FAILED: ${kind} directory has no model files at ${dir}`,
		);
	}
	// Stat the directory to get a stable inode for id derivation. Real
	// FFI will mmap each weight file independently; this default loader
	// collapses them into one region per kind for refcount purposes.
	const st = statSync(dir);
	const handle = ffi ? ensureContext(ctx) : null;
	if (ffi && handle !== null) {
		// Real fused build: load or re-page the heavy voice region now.
		// A compatibility runtime without region support returns ELIZA_ERR_NOT_IMPLEMENTED,
		// which surfaces as VoiceLifecycleError({code:"kernel-missing"})
		// before the lifecycle can enter voice-on.
		ffi.mmapAcquire(handle, kind);
	}
	return {
		id: `mmap:${kind}:${st.ino}`,
		path: dir,
		sizeBytes: st.size,
		async evictPages() {
			const evictHandle = ffi ? ensureContext(ctx) : null;
			if (ffi && evictHandle !== null) {
				// Real fused build: madvise / VirtualUnlock through the C ABI.
				// Throws VoiceLifecycleError on a negative return — the
				// lifecycle catches and re-classifies via `disarm-failed`.
				ffi.mmapEvict(evictHandle, kind);
			}
			// Else: no FFI handle (test TTS / no fused build) — nothing to
			// evict.
		},
		async release() {
			// The FFI owns the actual mmap; release is a refcount drop on
			// the JS side. The fused build's destroy path flushes any
			// remaining pages when the context is destroyed.
		},
	};
}

/** Re-export for the engine and tests that want the default loader. */
export { defaultLifecycleLoaders };

/**
 * Platform-specific shared-library suffix for the fused omnivoice build.
 * macOS dylib, Linux/Android so, Windows dll. Windows artifacts have
 * used both `elizainference.dll` and `libelizainference.dll` names in
 * cross-build toolchains, so the runtime probes both.
 */
function libraryFilenames(): string[] {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}

function locateBundleLibrary(bundleRoot: string): string {
	const exact = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
	if (exact && existsSync(exact)) return exact;

	const dirs = [
		path.join(bundleRoot, "lib"),
		exact ? path.dirname(exact) : null,
		process.env.ELIZA_INFERENCE_LIB_DIR?.trim() || null,
		...managedFusedRuntimeDirs(),
	].filter((dir): dir is string => Boolean(dir));

	for (const dir of dirs) {
		for (const name of libraryFilenames()) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return path.join(
		dirs[0] ?? path.join(bundleRoot, "lib"),
		libraryFilenames()[0] ?? "libelizainference.so",
	);
}

function directoryHasRegularFile(dir: string): boolean {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isFile()) return true;
	}
	return false;
}

function bundleHasRegularFile(dir: string): boolean {
	if (!existsSync(dir)) return false;
	try {
		return directoryHasRegularFile(dir);
	} catch {
		return false;
	}
}

function managedFusedRuntimeDirs(): string[] {
	if (process.env.ELIZA_INFERENCE_MANAGED_LOOKUP?.trim() === "0") {
		return [];
	}
	const root = localInferenceRoot();
	const platform = process.platform;
	const arch = os.arch();
	const candidates = [
		`${platform}-${arch}-metal-fused`,
		`${platform}-${arch}-vulkan-fused`,
		`${platform}-${arch}-cuda-fused`,
		`${platform}-${arch}-cpu-fused`,
	];
	return candidates.map((target) => path.join(root, "bin", "mtp", target));
}
