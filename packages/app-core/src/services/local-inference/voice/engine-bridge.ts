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
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
} from "./ffi-bindings";
import { loadElizaInferenceFfi } from "./ffi-bindings";
import {
  VoiceLifecycle,
  VoiceLifecycleError,
  type VoiceLifecycleLoaders,
} from "./lifecycle";
import { type CachedPhraseAudio, PhraseCache } from "./phrase-cache";
import { type SchedulerEvents, VoiceScheduler } from "./scheduler";
import {
  type MmapRegionHandle,
  SharedResourceRegistry,
} from "./shared-resources";
import {
  DEFAULT_VOICE_PRESET_REL_PATH,
  SpeakerPresetCache,
} from "./speaker-preset-cache";
import type {
  AudioChunk,
  AudioSink,
  OmniVoiceBackend,
  OmniVoiceTranscriber,
  Phrase,
  RejectedTokenRange,
  SchedulerConfig,
  SpeakerPreset,
  TextToken,
  TranscriptionAudio,
} from "./types";

const SAMPLE_RATE_DEFAULT = 24_000;
const RING_BUFFER_CAPACITY_DEFAULT = SAMPLE_RATE_DEFAULT * 4; // 4s
const PHRASE_MAX_TOKENS_DEFAULT = 12;
const STUB_PCM_MS_PER_PHRASE = 100;

/**
 * Structured startup failure. The engine MUST throw one of these when
 * voice mode is requested but cannot start (missing FFI, missing speaker
 * preset, missing fused build, manifest mismatch). The runtime then
 * refuses to activate the model — never silently degrades to text-only.
 */
export class VoiceStartupError extends Error {
  readonly code:
    | "missing-ffi"
    | "missing-speaker-preset"
    | "missing-bundle-root"
    | "missing-fused-build"
    | "already-started"
    | "not-started";

  constructor(code: VoiceStartupError["code"], message: string) {
    super(message);
    this.name = "VoiceStartupError";
    this.code = code;
  }
}

/**
 * Stub TTS backend that returns deterministic synthetic PCM. Each phrase
 * yields `STUB_PCM_MS_PER_PHRASE` ms of silence (zeros), with the
 * cancel signal honoured at the kernel-tick boundary so barge-in tests
 * observe cancellation without waiting on a real model.
 */
export class StubOmniVoiceBackend implements OmniVoiceBackend {
  readonly id = "stub" as const;
  private readonly sampleRate: number;
  calls = 0;

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
export class FfiOmniVoiceBackend implements OmniVoiceBackend {
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
    this.getContext = args.getContext ?? (() => {
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

  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    args.onKernelTick?.();
    const ctx = this.getContext();
    const out = new Float32Array(this.sampleRate * this.maxSecondsPerPhrase);
    const samples = this.ffi.ttsSynthesize({
      ctx,
      text: args.phrase.text,
      speakerPresetId: args.preset.voiceId,
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
   * When true, use `FfiOmniVoiceBackend` (will hard-fail at synthesize
   * time until the fused build lands). When false, use the stub backend
   * so tests and the streaming-graph integration can run end-to-end
   * with synthetic PCM.
   */
  useFfiBackend: boolean;
  /** Override sample rate. Defaults to 24 kHz. */
  sampleRate?: number;
  /** Override ring buffer capacity (samples). Defaults to 4 s @ 24 kHz. */
  ringBufferCapacity?: number;
  /** Phrase chunker `maxTokensPerPhrase`. Defaults to 12. */
  maxTokensPerPhrase?: number;
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

  private constructor(
    scheduler: VoiceScheduler,
    backend: OmniVoiceBackend,
    bundleRoot: string,
    lifecycle: VoiceLifecycle,
    ffi: ElizaInferenceFfi | null,
    ffiContextRef: FfiContextRef | null,
    asrAvailable: boolean,
  ) {
    this.scheduler = scheduler;
    this.backend = backend;
    this.bundleRoot = bundleRoot;
    this.lifecycle = lifecycle;
    this.ffi = ffi;
    this.ffiContextRef = ffiContextRef;
    this.asrAvailable = asrAvailable;
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

    const presetPath = path.join(opts.bundleRoot, DEFAULT_VOICE_PRESET_REL_PATH);
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
    const asrAvailable = bundleHasRegularFile(path.join(opts.bundleRoot, "asr"));
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
          opts.maxTokensPerPhrase ?? PHRASE_MAX_TOKENS_DEFAULT,
      },
      preset,
      ringBufferCapacity:
        opts.ringBufferCapacity ?? RING_BUFFER_CAPACITY_DEFAULT,
      sampleRate,
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
    );
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
    const chunk = await this.scheduler.synthesizeText(text);
    return encodeMonoPcm16Wav(chunk.pcm, chunk.sampleRate);
  }

  async transcribePcm(args: TranscriptionAudio): Promise<string> {
    this.assertVoiceOn("transcribe audio");
    if (!this.asrAvailable) {
      throw new VoiceStartupError(
        "missing-fused-build",
        `[voice] Local transcription is unavailable for this bundle: no ASR model files were installed under ${path.join(this.bundleRoot, "asr")}.`,
      );
    }
    if (!isTranscriber(this.backend)) {
      throw new VoiceStartupError(
        "missing-fused-build",
        `[voice] Local transcription requires the fused omnivoice FFI backend; current backend does not expose ASR.`,
      );
    }
    return this.backend.transcribe(args);
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

function isTranscriber(
  backend: OmniVoiceBackend,
): backend is OmniVoiceBackend & OmniVoiceTranscriber {
  return (
    typeof (backend as Partial<OmniVoiceTranscriber>).transcribe === "function"
  );
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

/**
 * Default lifecycle loaders derived from the bundle layout (per
 * AGENTS.md §2: `tts/omnivoice-<size>.gguf` + `asr/...`).
 *
 * When a live `ffi`/`ctx` pair is passed in, arming calls
 * `ffi.mmapAcquire(ctx, "tts" | "asr")` before the lifecycle can enter
 * `voice-on`, and the returned mmap handles' `evictPages()` calls
 * forward to `ffi.mmapEvict(ctx, "tts" | "asr")`. The C ABI is declared
 * in `scripts/omnivoice-fuse/ffi.h`. The real fused build implements
 * this against `mmap` / `madvise(MADV_DONTNEED)` on POSIX and
 * `VirtualUnlock + OfferVirtualMemory` on Windows. The stub library
 * returns `ELIZA_ERR_NOT_IMPLEMENTED`, which the binding raises as
 * `VoiceLifecycleError({code:"kernel-missing"})`.
 *
 * When `ffi` is null, acquire/evict are documented no-ops — used by the
 * stub TTS path in tests + dev (no real mmap exists). Directory and
 * "contains at least one file" checks still run for TTS. ASR is optional
 * for TTS-only bundles: a missing ASR directory gets a zero-byte virtual
 * region so voice-on can synthesize while local transcription stays disabled.
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
    loadAsrRegion: async () => {
      const asrDir = path.join(bundleRoot, "asr");
      if (!bundleHasRegularFile(asrDir)) {
        return virtualMmapRegion("asr", bundleRoot);
      }
      return bundleMmapRegion(asrDir, "asr", ffi, ctx);
    },
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

function virtualMmapRegion(
  kind: "asr",
  bundleRoot: string,
): MmapRegionHandle {
  return {
    id: `mmap:${kind}:virtual:${bundleRoot}`,
    path: path.join(bundleRoot, kind),
    sizeBytes: 0,
    async evictPages() {},
    async release() {},
  };
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
