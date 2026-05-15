/**
 * Engine ↔ voice scheduler bridge.
 *
 * Adapts the live `LocalInferenceEngine` (`engine.ts`) plus the DFlash
 * llama-server (`dflash-server.ts`) onto the voice scaffold's
 * `VoiceScheduler`. See `packages/inference/AGENTS.md` §4 for the
 * streaming graph this implements:
 *
 *   ASR → text tokens → DFlash drafter ↔ target verifier (text model)
 *        → phrase chunker → speaker preset cache + phrase cache
 *        → OmniVoice TTS → PCM ring buffer → audio out
 *
 * Plus rollback queue (DFlash rejection → cancel pending TTS chunks)
 * and barge-in cancellation (mic VAD → drain ring buffer + cancel TTS).
 *
 * Two TTS backends are exposed:
 *   - `StubOmniVoiceBackend`: deterministic synthetic PCM. Used by tests
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
import {
	KokoroOnnxRuntime,
	KokoroTtsBackend,
} from "@elizaos/shared/local-inference";
import { localInferenceRoot } from "../paths";
import { VoiceCancellationCoordinator } from "./cancellation-coordinator";
import { VoiceStartupError } from "./errors";
import { loadElizaInferenceFfi } from "./ffi-bindings";
import { VoiceLifecycle, VoiceLifecycleError } from "./lifecycle";
import {
	OptimisticGenerationPolicy,
	resolvePowerSourceState,
} from "./optimistic-policy";
import {
	DEFAULT_PHRASE_CACHE_SEED,
	FIRST_AUDIO_FILLERS,
	PhraseCache,
} from "./phrase-cache";
import { VoicePipeline } from "./pipeline";
import {
	LlamaServerDraftProposer,
	LlamaServerTargetVerifier,
	MissingAsrTranscriber,
} from "./pipeline-impls";
import { VoiceScheduler } from "./scheduler";
import { SharedResourceRegistry } from "./shared-resources";
import { VoiceAttributionPipeline } from "./speaker/attribution-pipeline";
import {
	DEFAULT_VOICE_PRESET_REL_PATH,
	SpeakerPresetCache,
} from "./speaker-preset-cache";
import { AsrUnavailableError, createStreamingTranscriber } from "./transcriber";

const SAMPLE_RATE_DEFAULT = 24_000;
const RING_BUFFER_CAPACITY_DEFAULT = SAMPLE_RATE_DEFAULT * 4; // 4s
/**
 * Runtime default for the no-punctuation phrase cap (`PhraseChunker.maxTokensPerPhrase`).
 * Punctuation (`, . ! ?`) is still the primary boundary; this only bounds
 * a run-on token stream. Kept small — equal to the DFlash draft window
 * (`DEFAULT_VOICE_MAX_DRAFT_TOKENS` in `engine.ts`) — so first-audio latency
 * is bounded (a phrase ≈ one draft round of audio, not 30 words) and a
 * DFlash-reject rollback drops at most one un-spoken chunk (AGENTS.md §4 —
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
 * default preset can be a real (v2) OmniVoice samantha freeze. With ABI v4
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
function ffiSpeakerPresetId(preset) {
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
export function nativeRejectedRangeToRollbackRange(event) {
	if (event.rejectedFrom < 0 || event.rejectedTo <= event.rejectedFrom) {
		return null;
	}
	return {
		fromIndex: event.rejectedFrom,
		toIndex: event.rejectedTo - 1,
	};
}
/** True when `backend` implements the `StreamingTtsBackend` seam. */
export function isStreamingTtsBackend(backend) {
	return typeof backend.synthesizeStream === "function";
}
/**
 * Stub TTS backend that returns deterministic synthetic PCM. Each phrase
 * yields `STUB_PCM_MS_PER_PHRASE` ms of silence (zeros), with the
 * cancel signal honoured at the kernel-tick boundary so barge-in tests
 * observe cancellation without waiting on a real model.
 */
export class StubOmniVoiceBackend {
	id = "stub";
	sampleRate;
	calls = 0;
	streamCalls = 0;
	constructor(sampleRate = SAMPLE_RATE_DEFAULT) {
		this.sampleRate = sampleRate;
	}
	async synthesize(args) {
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
	async synthesizeStream(args) {
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
 * the C stub at `scripts/omnivoice-fuse/ffi-stub.c`, which returns
 * `ELIZA_ERR_NOT_IMPLEMENTED` for `tts_synthesize` — the binding then
 * raises `VoiceLifecycleError({code:"kernel-missing"})`. The adapter
 * re-wraps that as `VoiceStartupError("missing-fused-build", ...)` so
 * the engine layer's startup-error taxonomy stays unified. No silent
 * fallback (AGENTS.md §3 + §9).
 */
export class FfiOmniVoiceBackend {
	id = "ffi";
	ffi;
	getContext;
	sampleRate;
	maxSecondsPerPhrase;
	constructor(args) {
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
	supportsStreamingTts() {
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
	async synthesize(args) {
		args.onKernelTick?.();
		const ctx = this.getContext();
		if (this.ffi.ttsStreamSupported()) {
			const parts = [];
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
	async synthesizeStream(args) {
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
	cancelTts() {
		this.ffi.cancelTts(this.getContext());
	}
	/**
	 * Batch transcription. One-shot callers should use the fused batch ABI
	 * directly so the native side receives the original sample-rate metadata
	 * and can apply its own audio preprocessing. Live mic streaming remains
	 * available through `EngineVoiceBridge.createStreamingTranscriber()`.
	 */
	async transcribe(args) {
		return this.ffi.asrTranscribe({
			ctx: this.getContext(),
			pcm: args.pcm,
			sampleRateHz: args.sampleRate,
		});
	}
}
function buildCancellationWiring(opts) {
	if (!opts.runtime) return null;
	let ttsStopHandler = null;
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
	scheduler;
	backend;
	lifecycle;
	/** Loaded FFI handle when running against the fused build (else null). */
	ffi;
	/** Lazily-created FFI context this bridge owns; destroyed in `dispose()`. */
	ffiContextRef;
	asrAvailable;
	bundleRoot;
	/** The phrase cache the scheduler dispatches against — held so the bridge
	 *  can answer "is phrase X cached" for the first-audio filler and seed the
	 *  idle-time auto-prewarm. */
	phraseCache;
	/** In-flight fused turn (`runVoiceTurn`), if any — cancelled on barge-in. */
	activePipeline = null;
	attributionPipeline;
	cancellationCoordinator;
	optimisticGenerationPolicy;
	bargeInBindings = new Map();
	constructor(
		scheduler,
		backend,
		bundleRoot,
		lifecycle,
		ffi,
		ffiContextRef,
		asrAvailable,
		phraseCache,
		attributionPipeline = null,
		cancellationCoordinator = null,
		optimisticGenerationPolicy = null,
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
	}
	get ffiCtx() {
		return this.ffiContextRef?.current ?? null;
	}
	/**
	 * Tear down the FFI context the bridge owns. Idempotent; safe to call
	 * multiple times. Callers should `disarm()` first to drop voice
	 * resources, then `dispose()` to close the FFI handle.
	 */
	dispose() {
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
	static start(opts) {
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
		// setting `useFfiBackend: false` (stub TTS + no-op evict).
		let ffiHandle = null;
		let ffiContextRef = null;
		let backend;
		const asrAvailable = bundleHasRegularFile(
			path.join(opts.bundleRoot, "asr"),
		);
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
					`[voice] Fused omnivoice library not found under ${path.join(opts.bundleRoot, "lib")} (tried ${libraryFilenames().join(", ")}). Build via packages/app-core/scripts/build-llama-cpp-dflash.mjs (omnivoice-fuse target).`,
				);
			}
			ffiHandle = loadElizaInferenceFfi(libPath);
			const contextRef = {
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
			backend = new FfiOmniVoiceBackend({
				ffi: ffiHandle,
				getContext: contextRef.ensure,
				sampleRate,
			});
		} else {
			backend = new StubOmniVoiceBackend(sampleRate);
		}
		const config = {
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
		// Wire the voice lifecycle. The lifecycle starts in `voice-off` —
		// heavy resources (TTS + ASR mmap regions) are loaded only when
		// `arm()` is called. The default loaders derive an mmap-style
		// handle from the bundle's `tts/` and `asr/` directories so that
		// production paths get real eviction calls; tests inject
		// `lifecycleLoaders` to assert the disarm path.
		const registry = opts.sharedResources ?? new SharedResourceRegistry();
		const loaders =
			opts.lifecycleLoaders ??
			defaultLifecycleLoaders(opts.bundleRoot, ffiHandle, ffiContextRef);
		const lifecycle = new VoiceLifecycle({ registry, loaders });
		let attributionPipeline = null;
		if (opts.profileStore) {
			const bundleRootForEncoder = opts.bundleRoot;
			let resolvedEncoder = null;
			let encoderLoadError = null;
			const lazyEncoder = {
				modelId: "wespeaker/resnet34-lm-int8",
				embeddingDim: 256,
				sampleRate: 16_000,
				async encode(pcm) {
					if (encoderLoadError) throw encoderLoadError;
					if (!resolvedEncoder) {
						const { WespeakerEncoder } = await import("./speaker/encoder");
						const modelPath = `${bundleRootForEncoder}/speaker/encoder.onnx`;
						try {
							resolvedEncoder = await WespeakerEncoder.load(modelPath);
						} catch (err) {
							encoderLoadError =
								err instanceof Error ? err : new Error(String(err));
							throw encoderLoadError;
						}
					}
					return resolvedEncoder.encode(pcm);
				},
				async dispose() {
					await resolvedEncoder?.dispose();
				},
			};
			attributionPipeline = new VoiceAttributionPipeline({
				encoder: lazyEncoder,
				profileStore: opts.profileStore,
			});
		}
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
			wiring?.coordinator ?? null,
			wiring?.policy ?? null,
		);
		if (wiring) wiring.bindTtsStop(() => bridge.triggerBargeIn());
		return bridge;
	}
	/**
	 * Kokoro-only path. Skips bundle-root / speaker-preset / FFI checks
	 * (Kokoro picks voices by id against `KOKORO_VOICE_PACKS`) and
	 * synthesizes a minimal `SpeakerPreset` keyed to the discovered voice
	 * id. Defaults lifecycle loaders to no-op handles since ORT owns the
	 * model memory. `asrAvailable` is `false`: callers needing ASR
	 * construct `createStreamingTranscriber` directly.
	 */
	static startKokoroOnly(opts) {
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
		const preset = {
			voiceId: kokoro.defaultVoiceId,
			embedding: new Float32Array(0),
			bytes: new Uint8Array(0),
		};
		const runtime = new KokoroOnnxRuntime({
			layout: kokoro.layout,
			expectedSha256: null,
		});
		const backend = new KokoroTtsBackend({
			layout: kokoro.layout,
			runtime,
			defaultVoiceId: kokoro.defaultVoiceId,
		});
		const phraseCache = new PhraseCache();
		for (const entry of opts.prewarmedPhrases ?? []) {
			phraseCache.put(entry);
		}
		const config = {
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
			wiring?.coordinator ?? null,
			wiring?.policy ?? null,
		);
		if (wiring) wiring.bindTtsStop(() => bridge.triggerBargeIn());
		return bridge;
	}
	/**
	 * True when this bridge runs against a TTS backend that produces real
	 * audio — i.e. anything but the `StubOmniVoiceBackend` (which yields
	 * zeros and is tests-only). The prewarm + first-audio-filler paths gate
	 * on this so the cache never holds silence (AGENTS.md §3 — no fake data).
	 */
	hasRealTtsBackend() {
		return !(this.backend instanceof StubOmniVoiceBackend);
	}
	/**
	 * Lazy-load the TTS mmap region, optional ASR region, and the voice
	 * scheduler nodes via the lifecycle state machine. Idempotent for
	 * repeated calls in `voice-on` (returns the existing armed resources).
	 * Surfaces RAM pressure / mmap-fail / kernel-missing as `VoiceLifecycleError` —
	 * see `lifecycle.ts` for the full error taxonomy.
	 */
	async arm() {
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
	async disarm() {
		if (this.lifecycle.current().kind !== "voice-on") return;
		await this.settle();
		await this.lifecycle.disarm();
	}
	/**
	 * Forward an accepted text token from the verifier into the scheduler.
	 * Tokens that fill a phrase trigger TTS dispatch on the same scheduler
	 * tick (AGENTS.md §4 — no buffering past phrase boundaries).
	 */
	async pushAcceptedToken(token, acceptedAt = Date.now()) {
		await this.scheduler.accept(token, acceptedAt);
	}
	/**
	 * DFlash rejection → rollback queue. The scheduler cancels any
	 * in-flight TTS forward pass for phrases that overlap the rejected
	 * token range and emits an `onRollback` event for observability.
	 * Already-played audio cannot be unplayed; the chunker is sized so
	 * rollback is rare and cheap.
	 */
	async pushRejectedRange(range) {
		await this.scheduler.reject(range);
	}
	/**
	 * Voice activity detected on the mic input → cancel everything.
	 * Drains the ring buffer immediately, flushes the chunker queue, and
	 * marks every in-flight cancel signal so synthesise loops exit at the
	 * next kernel boundary (AGENTS.md §4 — barge-in cancellation MUST be
	 * within one kernel tick).
	 */
	triggerBargeIn() {
		// Cancel the text side first (stop ASR / drafter / verifier at the next
		// kernel boundary), then the audio side (ring-buffer drain + chunker
		// flush + in-flight TTS cancel). The pipeline also wires its own
		// barge-in listener onto the scheduler, so `onMicActive()` alone would
		// suffice — calling `cancel()` first just stops the next HTTP body
		// sooner.
		this.activePipeline?.cancel();
		this.scheduler.bargeIn.onMicActive();
	}
	cancellationCoordinatorOrNull() {
		return this.cancellationCoordinator;
	}
	optimisticPolicyOrNull() {
		return this.optimisticGenerationPolicy;
	}
	bindBargeInControllerForRoom(roomId) {
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
	async settle() {
		await this.scheduler.flushPending();
		await this.scheduler.waitIdle();
	}
	async synthesizeTextToWav(text, signal) {
		this.assertVoiceOn("synthesize speech");
		if (!this.hasRealTtsBackend()) {
			throw new VoiceStartupError(
				"missing-fused-build",
				"[voice] Direct speech synthesis requires a fused OmniVoice backend. The stub backend is only allowed in scheduler/unit tests.",
			);
		}
		const chunk = await this.scheduler.synthesizeText(text, signal);
		return encodeMonoPcm16Wav(chunk.pcm, chunk.sampleRate);
	}
	/**
	 * The streaming-TTS seam W9's scheduler drives: returns the active
	 * backend as a `StreamingTtsBackend` (`FfiOmniVoiceBackend` against the
	 * fused build, `StubOmniVoiceBackend` for tests). The scheduler calls
	 * `synthesizeStream(...)` for each phrase and writes the delivered PCM
	 * segments into its `PcmRingBuffer` on the same scheduler tick. Returns
	 * null when an injected `backendOverride` does not implement the seam.
	 */
	streamingTtsBackend() {
		return isStreamingTtsBackend(this.backend) ? this.backend : null;
	}
	/**
	 * True when the loaded fused `libelizainference` runs the DFlash
	 * speculative loop in-process and can emit native accept/reject
	 * verifier events. When true, callers (W9's turn controller /
	 * `dflash-server.ts` wiring) should subscribe via
	 * `subscribeNativeVerifier()` and SKIP the `llama-server` SSE
	 * `{"verifier":{"rejected":[a,b]}}` side-channel — the SSE path stays
	 * only as the non-fused desktop text fallback. False whenever there is
	 * no FFI handle or the build pre-dates the verifier callback.
	 */
	hasNativeVerifier() {
		// ABI v3 exports `eliza_inference_set_verifier_callback`, but the
		// current generated adapter returns ELIZA_ERR_NOT_IMPLEMENTED until the
		// native DFlash speculative loop is ported into libelizainference. Do
		// not let callers skip the SSE verifier fallback merely because the
		// symbol exists.
		return false;
	}
	/**
	 * Register the native DFlash verifier callback on the fused runtime
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
	subscribeNativeVerifier(onEvent) {
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
	async prewarmPhrases(texts, opts = {}) {
		this.assertVoiceOn("prewarm voice phrases");
		return this.scheduler.prewarmPhrases(texts, opts);
	}
	/**
	 * Idle-time auto-prewarm hook: synthesize the canonical phrase-cache seed
	 * (`DEFAULT_PHRASE_CACHE_SEED`) so common openers/acks are cached before
	 * the next turn. The voice bridge / connector calls this when the loop is
	 * idle. No-op (returns `{ warmed: 0, cached: 0 }`) unless a real TTS
	 * backend is present and voice is armed — we never cache the stub's zeros
	 * (AGENTS.md §3).
	 */
	async prewarmIdlePhrases(opts = {}) {
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
	playFirstAudioFiller() {
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
	 * word-confirm gate (W1) listens to. Resolves the adapter chain:
	 *   fused `libelizainference` streaming ASR (final path, gated on a
	 *   working decoder AND a bundled ASR model) → fused batch ASR over the
	 *   same bundled model → `AsrUnavailableError`. The Eliza-1 bridge runs
	 *   only the fused path; the whisper.cpp interim fallback has been removed.
	 *
	 * Pass W1's `vad` event stream to gate decoding to active speech
	 * windows. Caller owns the returned transcriber's lifecycle (`dispose()`).
	 */
	createStreamingTranscriber(opts) {
		this.assertVoiceOn("create streaming transcriber");
		const contextRef = this.ffiContextRef;
		return createStreamingTranscriber({
			ffi: this.ffi,
			getContext: contextRef ? () => contextRef.ensure() : undefined,
			asrBundlePresent: this.asrAvailable,
			vad: opts?.vad,
		});
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
	async transcribePcm(args, signal) {
		this.assertVoiceOn("transcribe audio");
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		const backendBatch = this.backend;
		if (typeof backendBatch.transcribe === "function") {
			const transcript = await backendBatch.transcribe(args);
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
	 * DFlash drafter and the target verifier kick off concurrently, accepted
	 * tokens flow into this bridge's phrase chunker → TTS → ring buffer on
	 * the same tick, rejected draft tails roll back not-yet-spoken audio, and
	 * a mic-VAD barge-in cancels everything at the next kernel boundary.
	 *
	 * The drafter + verifier are wired against the running DFlash llama-server
	 * (`textRunner`); the transcriber is the fused ABI's ASR when this bridge
	 * was started with the FFI backend and the bundle ships an `asr/` region.
	 * In voice mode a missing ASR region is a hard `VoiceStartupError` — no
	 * silent cloud fallback (AGENTS.md §3 + §7).
	 *
	 * Resolves with the turn's exit reason. Throws if no turn is wired or one
	 * is already in flight. The created pipeline is held until the turn ends
	 * so `bargeIn()` can cancel it.
	 */
	async runVoiceTurn(audio, textRunner, config, events) {
		this.assertVoiceOn("run a voice turn");
		if (this.attributionPipeline && events?.onAttribution) {
			const onAttribution = events.onAttribution;
			const attribution = this.attributionPipeline;
			const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			void attribution
				.attribute({
					turnId,
					pcm: audio.pcm,
				})
				.then(onAttribution)
				.catch((err) => {
					console.warn(
						`[voice-bridge] speaker attribution failed for turn ${turnId}:`,
						err instanceof Error ? err.message : String(err),
					);
				});
		}
		const pipeline = this.buildPipeline(textRunner, config, events);
		this.activePipeline = pipeline;
		try {
			return await pipeline.run(audio);
		} finally {
			if (this.activePipeline === pipeline) this.activePipeline = null;
		}
	}
	/** Construct the `VoicePipeline` for this bridge (no-run). Exposed for tests. */
	buildPipeline(textRunner, config, events) {
		const transcriber = this.resolveTranscriber();
		const deps = {
			scheduler: this.scheduler,
			transcriber,
			drafter: new LlamaServerDraftProposer(textRunner),
			verifier: new LlamaServerTargetVerifier(textRunner),
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
	resolveTranscriber() {
		const ctxRef = this.ffiContextRef;
		try {
			return createStreamingTranscriber({
				ffi: this.ffi,
				getContext: ctxRef ? () => ctxRef.ensure() : undefined,
				asrBundlePresent: this.asrAvailable,
			});
		} catch (err) {
			if (err instanceof AsrUnavailableError) {
				return new MissingAsrTranscriber(err.message);
			}
			throw err;
		}
	}
	/** Diagnostic accessor — bundle root the bridge is wired against. */
	bundlePath() {
		return this.bundleRoot;
	}
	assertVoiceOn(action) {
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
export function encodeMonoPcm16Wav(pcm, sampleRate) {
	const channels = 1;
	const bytesPerSample = 2;
	const dataBytes = pcm.length * bytesPerSample;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	writeAscii(out, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(out, 8, "WAVE");
	writeAscii(out, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeAscii(out, 36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (const sample of pcm) {
		const clamped = Math.max(-1, Math.min(1, sample));
		const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		view.setInt16(offset, Math.round(value), true);
		offset += bytesPerSample;
	}
	return out;
}
export function decodeMonoPcm16Wav(bytes) {
	if (bytes.byteLength < 44) {
		throw new Error("[voice] WAV input is too short to contain a header");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		readAscii(bytes, 0, 4) !== "RIFF" ||
		readAscii(bytes, 8, 4) !== "WAVE" ||
		readAscii(bytes, 12, 4) !== "fmt "
	) {
		throw new Error("[voice] Local transcription expects mono PCM16 WAV bytes");
	}
	const audioFormat = view.getUint16(20, true);
	const channels = view.getUint16(22, true);
	const sampleRate = view.getUint32(24, true);
	const bitsPerSample = view.getUint16(34, true);
	if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
		throw new Error(
			`[voice] Local transcription expects mono PCM16 WAV (format=1 channels=1 bits=16); got format=${audioFormat} channels=${channels} bits=${bitsPerSample}`,
		);
	}
	let pos = 36;
	while (pos + 8 <= bytes.byteLength) {
		const chunkId = readAscii(bytes, pos, 4);
		const chunkBytes = view.getUint32(pos + 4, true);
		const dataStart = pos + 8;
		if (chunkId === "data") {
			if (dataStart + chunkBytes > bytes.byteLength) {
				throw new Error("[voice] WAV data chunk exceeds input length");
			}
			if (chunkBytes % 2 !== 0) {
				throw new Error("[voice] WAV PCM16 data chunk has odd byte length");
			}
			const pcm = new Float32Array(chunkBytes / 2);
			for (let i = 0; i < pcm.length; i++) {
				pcm[i] = view.getInt16(dataStart + i * 2, true) / 0x8000;
			}
			return { pcm, sampleRate };
		}
		pos = dataStart + chunkBytes + (chunkBytes % 2);
	}
	throw new Error("[voice] WAV input is missing a data chunk");
}
function writeAscii(out, offset, text) {
	for (let i = 0; i < text.length; i++) {
		out[offset + i] = text.charCodeAt(i);
	}
}
function readAscii(bytes, offset, length) {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += String.fromCharCode(bytes[offset + i]);
	}
	return out;
}
function readPositiveIntEnv(name) {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
function ensureContext(ref) {
	if (ref === null) return null;
	if (typeof ref === "object" && "ensure" in ref) return ref.ensure();
	return ref;
}
/**
 * No-op lifecycle loaders for the Kokoro-only bridge. ORT owns the
 * model memory; nothing to mmap-acquire or evict. ASR is not served
 * from this path — callers that need ASR construct
 * `createStreamingTranscriber` directly (the chain in `transcriber.ts`
 * supports `openvino-whisper` and `whisper.cpp` without a bundle).
 */
function kokoroOnlyLifecycleLoaders() {
	const noopMmap = (id) => ({
		id,
		path: "",
		sizeBytes: 0,
		async evictPages() {
			// Nothing to evict — ORT owns the model bytes.
		},
		async release() {
			// No mmap region to release.
		},
	});
	return {
		loadTtsRegion: async () => noopMmap("kokoro:tts"),
		loadAsrRegion: async () => noopMmap("kokoro:asr"),
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
function defaultLifecycleLoaders(bundleRoot, ffi, ctx) {
	return {
		loadTtsRegion: async () =>
			bundleMmapRegion(path.join(bundleRoot, "tts"), "tts", ffi, ctx),
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
 * is supplied. With no FFI handle (stub mode), those calls are
 * deliberate no-ops because no real mmap was made. The lifecycle test
 * still asserts the call shape via injected mocks.
 */
function bundleMmapRegion(dir, kind, ffi, ctx) {
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
		// A stub or incomplete runtime returns ELIZA_ERR_NOT_IMPLEMENTED,
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
			// Else: no FFI handle (stub TTS / no fused build) — nothing to
			// evict. Documented no-op.
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
function libraryFilenames() {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}
function locateBundleLibrary(bundleRoot) {
	const exact = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
	if (exact && existsSync(exact)) return exact;
	const dirs = [
		path.join(bundleRoot, "lib"),
		exact ? path.dirname(exact) : null,
		process.env.ELIZA_INFERENCE_LIB_DIR?.trim() || null,
		...managedFusedRuntimeDirs(),
	].filter((dir) => Boolean(dir));
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
function directoryHasRegularFile(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isFile()) return true;
	}
	return false;
}
function bundleHasRegularFile(dir) {
	if (!existsSync(dir)) return false;
	try {
		return directoryHasRegularFile(dir);
	} catch {
		return false;
	}
}
function managedFusedRuntimeDirs() {
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
	return candidates.map((target) => path.join(root, "bin", "dflash", target));
}
//# sourceMappingURL=engine-bridge.js.map
