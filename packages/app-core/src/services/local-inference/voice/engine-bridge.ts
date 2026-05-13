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
import { localInferenceRoot } from "../paths";
import { VoiceStartupError } from "./errors";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  NativeVerifierEvent,
} from "./ffi-bindings";
import { loadElizaInferenceFfi } from "./ffi-bindings";
import {
  VoiceLifecycle,
  VoiceLifecycleError,
  type VoiceLifecycleLoaders,
} from "./lifecycle";
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
  type DflashTextRunner,
  LlamaServerDraftProposer,
  LlamaServerTargetVerifier,
  MissingAsrTranscriber,
} from "./pipeline-impls";
import { type SchedulerEvents, VoiceScheduler } from "./scheduler";
import {
  type MmapRegionHandle,
  SharedResourceRegistry,
} from "./shared-resources";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_PRESET_REL_PATH,
  SpeakerPresetCache,
} from "./speaker-preset-cache";
import {
  AsrUnavailableError,
  createStreamingTranscriber,
  type WhisperCppOptions,
} from "./transcriber";
import type {
  AudioChunk,
  AudioSink,
  OmniVoiceBackend,
  Phrase,
  RejectedTokenRange,
  SchedulerConfig,
  SpeakerPreset,
  StreamingTranscriber,
  TextToken,
  TranscriptionAudio,
  VadEventSource,
} from "./types";

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

function ffiSpeakerPresetId(preset: SpeakerPreset): string | null {
  return preset.voiceId === DEFAULT_VOICE_ID ? null : preset.voiceId;
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
 * DFlash-rejected tail).
 *
 * Both `OmniVoiceBackend` implementations in this module satisfy it:
 *   - `FfiOmniVoiceBackend` forwards to
 *     `eliza_inference_tts_synthesize_stream` when the loaded build
 *     advertises streaming TTS (`tts_stream_supported() == 1`), else it
 *     synthesizes whole and emits the result as one body chunk + a final
 *     tail (no silent "streaming" lie — the chunk count just collapses
 *     to one when the build is non-streaming);
 *   - `StubOmniVoiceBackend` emits deterministic synthetic PCM split
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
  backend: OmniVoiceBackend,
): backend is OmniVoiceBackend & StreamingTtsBackend {
  return (
    typeof (backend as Partial<StreamingTtsBackend>).synthesizeStream ===
    "function"
  );
}

/**
 * Stub TTS backend that returns deterministic synthetic PCM. Each phrase
 * yields `STUB_PCM_MS_PER_PHRASE` ms of silence (zeros), with the
 * cancel signal honoured at the kernel-tick boundary so barge-in tests
 * observe cancellation without waiting on a real model.
 */
export class StubOmniVoiceBackend
  implements OmniVoiceBackend, StreamingTtsBackend
{
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
 * the C stub at `scripts/omnivoice-fuse/ffi-stub.c`, which returns
 * `ELIZA_ERR_NOT_IMPLEMENTED` for `tts_synthesize` — the binding then
 * raises `VoiceLifecycleError({code:"kernel-missing"})`. The adapter
 * re-wraps that as `VoiceStartupError("missing-fused-build", ...)` so
 * the engine layer's startup-error taxonomy stays unified. No silent
 * fallback (AGENTS.md §3 + §9).
 */
export class FfiOmniVoiceBackend
  implements OmniVoiceBackend, StreamingTtsBackend
{
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
}

export interface EngineVoiceBridgeOptions {
  /**
   * Bundle root on disk. Must contain `cache/voice-preset-default.bin`
   * and the FFI library (`lib/libelizainference.{dylib,so}`) when
   * `useFfiBackend === true`.
   */
  bundleRoot: string;
  /**
   * When true, use `FfiOmniVoiceBackend`. When false, use the stub backend
   * only for lifecycle/unit tests; live sessions and direct synthesis reject
   * the stub before user-visible audio can be emitted.
   */
  useFfiBackend: boolean;
  /** Override sample rate. Defaults to 24 kHz. */
  sampleRate?: number;
  /** Override ring buffer capacity (samples). Defaults to 4 s @ 24 kHz. */
  ringBufferCapacity?: number;
  /** Phrase chunker `maxTokensPerPhrase` (no-punctuation run-on cap). Defaults to
   *  `ELIZA_VOICE_MAX_TOKENS_PER_PHRASE` or 8 (one DFlash draft round). */
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
  backendOverride?: OmniVoiceBackend;
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
  /** Optional whisper.cpp interim ASR configuration. */
  whisper?: WhisperCppOptions;
}

/**
 * Wires the voice scaffold (`VoiceScheduler` + helpers) onto the engine.
 * One bridge per active voice session — created in
 * `LocalInferenceEngine.startVoice()` and disposed when the engine
 * unloads or `stopVoice()` is called.
 */
export class EngineVoiceBridge {
  readonly scheduler: VoiceScheduler;
  readonly backend: OmniVoiceBackend;
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
  private readonly whisper?: WhisperCppOptions;

  private constructor(
    scheduler: VoiceScheduler,
    backend: OmniVoiceBackend,
    bundleRoot: string,
    lifecycle: VoiceLifecycle,
    ffi: ElizaInferenceFfi | null,
    ffiContextRef: FfiContextRef | null,
    asrAvailable: boolean,
    phraseCache: PhraseCache,
    whisper?: WhisperCppOptions,
  ) {
    this.scheduler = scheduler;
    this.backend = backend;
    this.bundleRoot = bundleRoot;
    this.lifecycle = lifecycle;
    this.ffi = ffi;
    this.ffiContextRef = ffiContextRef;
    this.asrAvailable = asrAvailable;
    this.phraseCache = phraseCache;
    this.whisper = whisper;
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
    let ffiHandle: ElizaInferenceFfi | null = null;
    let ffiContextRef: FfiContextRef | null = null;
    let backend: OmniVoiceBackend;
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
      backend = new FfiOmniVoiceBackend({
        ffi: ffiHandle,
        getContext: contextRef.ensure,
        sampleRate,
      });
    } else {
      backend = new StubOmniVoiceBackend(sampleRate);
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

    return new EngineVoiceBridge(
      scheduler,
      backend,
      opts.bundleRoot,
      lifecycle,
      ffiHandle,
      ffiContextRef,
      asrAvailable,
      phraseCache,
      opts.whisper,
    );
  }

  /**
   * True when this bridge runs against a TTS backend that produces real
   * audio — i.e. anything but the `StubOmniVoiceBackend` (which yields
   * zeros and is tests-only). The prewarm + first-audio-filler paths gate
   * on this so the cache never holds silence (AGENTS.md §3 — no fake data).
   */
  hasRealTtsBackend(): boolean {
    return !(this.backend instanceof StubOmniVoiceBackend);
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
   * DFlash rejection → rollback queue. The scheduler cancels any
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
   * Drain pending phrase data and wait for in-flight TTS to settle.
   * Used at the end of a turn so callers can synchronise on a quiescent
   * scheduler before they tear it down.
   */
  async settle(): Promise<void> {
    await this.scheduler.flushPending();
    await this.scheduler.waitIdle();
  }

  async synthesizeTextToWav(text: string): Promise<Uint8Array> {
    this.assertVoiceOn("synthesize speech");
    if (!this.hasRealTtsBackend()) {
      throw new VoiceStartupError(
        "missing-fused-build",
        "[voice] Direct speech synthesis requires a fused OmniVoice backend. The stub backend is only allowed in scheduler/unit tests.",
      );
    }
    const chunk = await this.scheduler.synthesizeText(text);
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
  streamingTtsBackend(): StreamingTtsBackend | null {
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
  hasNativeVerifier(): boolean {
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
   * backend is present and voice is armed — we never cache the stub's zeros
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
   * word-confirm gate (W1) listens to. Resolves the adapter chain:
   *   fused `libelizainference` streaming ASR (final path, gated on a
   *   working decoder AND a bundled ASR model) → fused batch ASR over the
   *   same bundled model → `AsrUnavailableError`. The Eliza-1 bridge
   *   deliberately disables the standalone whisper.cpp fallback so local
   *   voice mode never leaves the fused bundle.
   *
   * Pass W1's `vad` event stream to gate decoding to active speech
   * windows. Caller owns the returned transcriber's lifecycle (`dispose()`).
   */
  createStreamingTranscriber(opts?: {
    vad?: VadEventSource;
  }): StreamingTranscriber {
    this.assertVoiceOn("create streaming transcriber");
    const contextRef = this.ffiContextRef;
    return createStreamingTranscriber({
      ffi: this.ffi,
      getContext: contextRef ? () => contextRef.ensure() : undefined,
      asrBundlePresent: this.asrAvailable,
      vad: opts?.vad,
      whisper: this.whisper,
      allowWhisperFallback: false,
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
  async transcribePcm(args: TranscriptionAudio): Promise<string> {
    this.assertVoiceOn("transcribe audio");
    const backendBatch = this.backend as OmniVoiceBackend & {
      transcribe?: (args: TranscriptionAudio) => Promise<string>;
    };
    if (typeof backendBatch.transcribe === "function") {
      return backendBatch.transcribe(args);
    }
    const transcriber = this.createStreamingTranscriber();
    try {
      transcriber.feed({
        pcm: args.pcm,
        sampleRate: args.sampleRate,
        timestampMs: 0,
      });
      const final = await transcriber.flush();
      return final.partial;
    } finally {
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
  async runVoiceTurn(
    audio: TranscriptionAudio,
    textRunner: DflashTextRunner,
    config: VoicePipelineConfig,
    events?: VoicePipelineEvents,
  ): Promise<"done" | "token-cap" | "cancelled"> {
    this.assertVoiceOn("run a voice turn");
    const pipeline = this.buildPipeline(textRunner, config, events);
    this.activePipeline = pipeline;
    try {
      return await pipeline.run(audio);
    } finally {
      if (this.activePipeline === pipeline) this.activePipeline = null;
    }
  }

  /** Construct the `VoicePipeline` for this bridge (no-run). Exposed for tests. */
  buildPipeline(
    textRunner: DflashTextRunner,
    config: VoicePipelineConfig,
    events?: VoicePipelineEvents,
  ): VoicePipeline {
    const transcriber = this.resolveTranscriber();
    const deps: VoicePipelineDeps = {
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
  private resolveTranscriber(): StreamingTranscriber {
    const ctxRef = this.ffiContextRef;
    try {
      return createStreamingTranscriber({
        ffi: this.ffi,
        getContext: ctxRef ? () => ctxRef.ensure() : undefined,
        asrBundlePresent: this.asrAvailable,
        whisper: this.whisper,
        allowWhisperFallback: false,
      });
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

export function encodeMonoPcm16Wav(
  pcm: Float32Array,
  sampleRate: number,
): Uint8Array {
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

export function decodeMonoPcm16Wav(bytes: Uint8Array): TranscriptionAudio {
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

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    out[offset + i] = text.charCodeAt(i);
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

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
 * pressure; callers must reacquire before using the region again. The stub library
 * returns `ELIZA_ERR_NOT_IMPLEMENTED`, which the binding raises as
 * `VoiceLifecycleError({code:"kernel-missing"})`.
 *
 * When `ffi` is null, acquire/evict are documented no-ops — used by the
 * stub TTS path in tests + dev (no real mmap exists). Directory and
 * "contains at least one file" checks still run for both TTS and ASR.
 * ASR never gets a virtual fallback: voice-on requires a real bundled ASR
 * model file so the FFI path can acquire the `"asr"` region and surface
 * the fused ABI's diagnostic if the runtime is incomplete.
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

function defaultLifecycleLoaders(
  bundleRoot: string,
  ffi: ElizaInferenceFfi | null,
  ctx: ElizaInferenceContextHandle | FfiContextRef | null,
): VoiceLifecycleLoaders {
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
  return candidates.map((target) => path.join(root, "bin", "dflash", target));
}
