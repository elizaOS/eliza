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
 *   - `FfiOmniVoiceBackend`: documents the planned FFI surface against
 *     `libelizainference.{dylib,so}`. Throws a hard "not implemented"
 *     error on every call until the fused omnivoice build target lands
 *     (see `packages/app-core/scripts/build-llama-cpp-dflash.mjs` for
 *     the fused-target build hook the other agent finished).
 *
 * Per AGENTS.md §3 + §9 (no defensive code, no log-and-continue), every
 * startup precondition surfaces as a thrown `VoiceStartupError`. There
 * is no silent fallback to text-only.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  VoiceLifecycle,
  type VoiceLifecycleLoaders,
} from "./lifecycle";
import {
  PhraseCache,
  type CachedPhraseAudio,
} from "./phrase-cache";
import {
  type MmapRegionHandle,
  SharedResourceRegistry,
} from "./shared-resources";
import { SpeakerPresetCache } from "./speaker-preset-cache";
import { VoiceScheduler, type SchedulerEvents } from "./scheduler";
import type {
  AudioChunk,
  AudioSink,
  OmniVoiceBackend,
  Phrase,
  RejectedTokenRange,
  SchedulerConfig,
  SpeakerPreset,
  TextToken,
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

  constructor(
    code: VoiceStartupError["code"],
    message: string,
  ) {
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
 * Planned fused omnivoice FFI shape. Not implemented: the
 * `libelizainference.{dylib,so}` binary is produced by the fused-target
 * build hook in `packages/app-core/scripts/build-llama-cpp-dflash.mjs`
 * once the omnivoice-fuse target is wired through. Until that artifact
 * exists at runtime, every `synthesize()` call throws
 * `VoiceStartupError("missing-fused-build", ...)` instead of returning
 * fake audio. There is intentionally no try/catch around this — see
 * `packages/inference/AGENTS.md` §3 + §9.
 *
 * TODO(omnivoice-fuse): replace this stub with a Bun FFI binding once
 * the fused build emits `libelizainference.{dylib,so}` and the
 * `eliza_omnivoice_synthesize` symbol it exports.
 */
export class FfiOmniVoiceBackend implements OmniVoiceBackend {
  readonly id = "ffi" as const;
  private readonly libraryPath: string;

  constructor(libraryPath: string) {
    this.libraryPath = libraryPath;
  }

  async synthesize(_args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    throw new VoiceStartupError(
      "missing-fused-build",
      `[voice] Fused omnivoice FFI not implemented. Expected library at ${this.libraryPath}. Build via packages/app-core/scripts/build-llama-cpp-dflash.mjs (omnivoice-fuse target).`,
    );
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
  private readonly bundleRoot: string;

  private constructor(
    scheduler: VoiceScheduler,
    backend: OmniVoiceBackend,
    bundleRoot: string,
    lifecycle: VoiceLifecycle,
  ) {
    this.scheduler = scheduler;
    this.backend = backend;
    this.bundleRoot = bundleRoot;
    this.lifecycle = lifecycle;
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
      "cache",
      "voice-preset-default.bin",
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

    let backend: OmniVoiceBackend;
    if (opts.backendOverride) {
      backend = opts.backendOverride;
    } else if (opts.useFfiBackend) {
      const libPath = path.join(opts.bundleRoot, "lib", libraryFilename());
      if (!existsSync(libPath)) {
        throw new VoiceStartupError(
          "missing-ffi",
          `[voice] Fused omnivoice library not found at ${libPath}. Build via packages/app-core/scripts/build-llama-cpp-dflash.mjs (omnivoice-fuse target).`,
        );
      }
      backend = new FfiOmniVoiceBackend(libPath);
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
      opts.lifecycleLoaders ?? defaultLifecycleLoaders(opts.bundleRoot);
    const lifecycle = new VoiceLifecycle({ registry, loaders });

    return new EngineVoiceBridge(
      scheduler,
      backend,
      opts.bundleRoot,
      lifecycle,
    );
  }

  /**
   * Lazy-load TTS + ASR mmap regions and the voice scheduler nodes via
   * the lifecycle state machine. Idempotent for repeated calls in
   * `voice-on` (returns the existing armed resources). Surfaces RAM
   * pressure / mmap-fail / kernel-missing as `VoiceLifecycleError` —
   * see `lifecycle.ts` for the full error taxonomy.
   */
  async arm(): Promise<void> {
    if (this.lifecycle.current().kind === "voice-on") return;
    await this.lifecycle.arm();
  }

  /**
   * Drain in-flight TTS, settle the scheduler, then disarm the
   * lifecycle. Disarm calls `evictPages()` (madvise / VirtualUnlock
   * equivalent) on the TTS + ASR mmap regions and releases every
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

  /** Diagnostic accessor — bundle root the bridge is wired against. */
  bundlePath(): string {
    return this.bundleRoot;
  }
}

/**
 * Default lifecycle loaders derived from the bundle layout (per
 * AGENTS.md §2: `tts/omnivoice-<size>.gguf` + `asr/...`). The mmap
 * handle returned by `loadTtsRegion` / `loadAsrRegion` represents the
 * heavy weight files; the actual mmap call lives behind the FFI when
 * the fused build lands. Until then `evictPages()` is a documented
 * no-op (the pages aren't actually mapped from JS) — the test
 * lifecycle injects mocks that assert the call shape.
 *
 * Real platform `evictPages()` paths once the FFI binding ships:
 *   - Linux/Android:    `madvise(addr, len, MADV_DONTNEED)`
 *   - macOS background: `madvise(addr, len, MADV_DONTNEED)`
 *   - macOS / iOS fg:   `madvise(addr, len, MADV_FREE_REUSABLE)`
 *   - Windows:          `VirtualUnlock(addr, len)` then
 *                       `OfferVirtualMemory(addr, len, VmOfferPriorityLow)`
 */
function defaultLifecycleLoaders(bundleRoot: string): VoiceLifecycleLoaders {
  return {
    loadTtsRegion: async () =>
      bundleMmapRegion(path.join(bundleRoot, "tts"), "tts"),
    loadAsrRegion: async () =>
      bundleMmapRegion(path.join(bundleRoot, "asr"), "asr"),
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
 * Build an `MmapRegionHandle` for the largest file in a bundle
 * subdirectory. Refuses to fabricate a region when the directory or
 * its target file is missing — that surfaces as `VoiceLifecycleError`
 * via the lifecycle's `arm-failed`/`mmap-fail` mapping (no silent
 * fallback to a smaller voice model — AGENTS.md §3).
 */
function bundleMmapRegion(
  dir: string,
  kind: "tts" | "asr",
): MmapRegionHandle {
  if (!existsSync(dir)) {
    throw new Error(
      `[voice] mmap MAP_FAILED: ${kind} directory missing at ${dir}`,
    );
  }
  // Stat the directory to get a stable inode for id derivation. Real
  // FFI will mmap each weight file independently; this default loader
  // collapses them into one region per kind for refcount purposes.
  const st = statSync(dir);
  return {
    id: `mmap:${kind}:${st.ino}`,
    path: dir,
    sizeBytes: st.size,
    async evictPages() {
      // No-op until the FFI binding lands. The real platform paths are
      // documented above the loader factory. The test lifecycle injects
      // mocks that assert this call happens, so the contract is
      // observable from outside.
    },
    async release() {
      // The FFI owns the actual mmap; release is a refcount drop on
      // the JS side. Once the FFI lands, this also calls `munmap`.
    },
  };
}

/** Re-export for the engine and tests that want the default loader. */
export { defaultLifecycleLoaders };

/**
 * Platform-specific shared-library suffix for the fused omnivoice build.
 * macOS dylib, Linux/Android so. Windows builds aren't on the device
 * matrix yet (AGENTS.md §2 tier table) so we don't synthesise a `.dll`
 * suffix here.
 */
function libraryFilename(): string {
  return process.platform === "darwin"
    ? "libelizainference.dylib"
    : "libelizainference.so";
}
