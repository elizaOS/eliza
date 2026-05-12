/**
 * Voice activity detection — the audio front-end's two-tier gate.
 *
 *   Tier 1 — `RmsEnergyGate`. A frame-level RMS threshold with hysteresis.
 *            Sub-frame latency, no model. Its rising edge is the "wake the
 *            response pipeline" signal (KV-prefill the response prompt,
 *            preload the drafter, pre-generate the first filler). It NEVER
 *            substitutes for Silero — it only decides "is there acoustic
 *            activity right now".
 *
 *   Tier 2 — a model VAD provider. Resolver order is Qwen toolkit adapter
 *            when supplied, native libelizainference Silero, then the
 *            MIT-licensed Silero VAD v5 ONNX model
 *            (`vad/silero-vad-int8.onnx` in the Eliza-1 bundle layout). 512-
 *            sample windows at 16 kHz (32 ms hop), one speech probability per
 *            window. This is the *authoritative* speech/no-speech signal — it
 *            gates ASR and drives turn-taking.
 *
 *   `VadDetector` wires both together and emits the `VadEvent` stream
 *   (`speech-start` / `speech-active` / `speech-pause` / `speech-end` /
 *   `blip`) plus the raw `EnergyGateEvent` stream.
 *
 * No fallback sludge: if no model VAD provider can be loaded,
 * `createVadDetector()` throws `VadUnavailableError`. The caller surfaces
 * "VAD unavailable — voice features degrade" — there is no silent downgrade to
 * the RMS gate (AGENTS.md §3).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { localInferenceRoot } from "../paths";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  NativeVadHandle,
} from "./ffi-bindings";
import {
  loadOnnxRuntime,
  OnnxRuntimeUnavailableError,
  type OrtInferenceSession,
  type OrtTensorCtor,
} from "./onnx-runtime";
import type {
  EnergyGateEvent,
  EnergyGateListener,
  PcmFrame,
  VadEvent,
  VadEventListener,
} from "./types";

/** Thrown when the Silero VAD backend cannot be loaded — missing
 *  `onnxruntime-node`, missing model file, or a corrupt model. There is no
 *  fallback; voice features that depend on VAD must surface this. */
export class VadUnavailableError extends Error {
  readonly code:
    | "ort-missing"
    | "model-missing"
    | "model-load-failed"
    | "provider-missing";
  constructor(code: VadUnavailableError["code"], message: string) {
    super(message);
    this.name = "VadUnavailableError";
    this.code = code;
  }
}

async function loadOrt() {
  try {
    return await loadOnnxRuntime();
  } catch (err) {
    if (err instanceof OnnxRuntimeUnavailableError) {
      throw new VadUnavailableError(
        "ort-missing",
        `${err.message} Install it to enable on-device VAD; voice turn-taking and barge-in are unavailable without it.`,
      );
    }
    throw err;
  }
}

/** Relative path of the Silero model inside an Eliza-1 bundle. */
export const SILERO_VAD_BUNDLE_REL_PATH = path.join(
  "vad",
  "silero-vad-int8.onnx",
);

/**
 * Resolve the Silero model on disk. Search order:
 *   1. explicit `modelPath`
 *   2. `<bundleRoot>/vad/silero-vad-int8.onnx`
 *   3. `<state-dir>/local-inference/vad/silero-vad-int8.onnx` (shared cache)
 *   4. `$ELIZA_VAD_MODEL_PATH`
 * Returns `null` when none exist.
 */
export function resolveSileroVadPath(opts: {
  modelPath?: string;
  bundleRoot?: string;
}): string | null {
  const candidates: Array<string | undefined> = [
    opts.modelPath,
    opts.bundleRoot
      ? path.join(opts.bundleRoot, SILERO_VAD_BUNDLE_REL_PATH)
      : undefined,
    path.join(localInferenceRoot(), SILERO_VAD_BUNDLE_REL_PATH),
    process.env.ELIZA_VAD_MODEL_PATH?.trim() || undefined,
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return path.resolve(c);
  }
  return null;
}

const SILERO_WINDOW_16K = 512; // samples per inference window @ 16 kHz
const SILERO_STATE_SHAPE = [2, 1, 128] as const; // combined LSTM (h, c)

function validateSileroSampleRate(sampleRate: number): void {
  if (sampleRate !== 16_000) {
    throw new VadUnavailableError(
      "model-load-failed",
      `[voice] Silero VAD v5 only supports 16 kHz; got ${sampleRate}. Resample the mic stream to 16 kHz before the VAD.`,
    );
  }
}

/**
 * Thin wrapper over the Silero VAD v5 ONNX graph. Stateful: `process()`
 * carries the LSTM state across calls and expects a 512-sample window at
 * 16 kHz (the only window size this graph supports). `reset()` clears the
 * state at utterance boundaries.
 */
export class SileroVad {
  private constructor(
    private readonly session: OrtInferenceSession,
    private readonly Tensor: OrtTensorCtor,
    readonly sampleRate: number,
  ) {}

  /** Window size in samples this model expects (512 @ 16 kHz). */
  get windowSamples(): number {
    return SILERO_WINDOW_16K;
  }

  private state: Float32Array = new Float32Array(2 * 1 * 128);

  /** Load the Silero model. Throws `VadUnavailableError` on any failure. */
  static async load(
    opts: { modelPath?: string; bundleRoot?: string; sampleRate?: number } = {},
  ): Promise<SileroVad> {
    const sampleRate = opts.sampleRate ?? 16_000;
    validateSileroSampleRate(sampleRate);
    const resolved = resolveSileroVadPath(opts);
    if (!resolved) {
      throw new VadUnavailableError(
        "model-missing",
        `[voice] Silero VAD model not found. Looked for ${SILERO_VAD_BUNDLE_REL_PATH} in the Eliza-1 bundle and under ${localInferenceRoot()}. Download the MIT-licensed Silero VAD (~2 MB) and stage it there, or set ELIZA_VAD_MODEL_PATH.`,
      );
    }
    const ort = await loadOrt();
    let session: OrtInferenceSession;
    try {
      session = await ort.InferenceSession.create(resolved);
    } catch (err) {
      throw new VadUnavailableError(
        "model-load-failed",
        `[voice] Failed to load Silero VAD model at ${resolved}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return new SileroVad(session, ort.Tensor, sampleRate);
  }

  /** Clear the LSTM state. Call at the start of a new utterance. */
  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
  }

  /**
   * Run one window. `window` MUST be exactly `windowSamples` long. Returns
   * the speech probability in [0, 1].
   */
  async process(window: Float32Array): Promise<number> {
    if (window.length !== SILERO_WINDOW_16K) {
      throw new Error(
        `[voice] SileroVad.process expects a ${SILERO_WINDOW_16K}-sample window; got ${window.length}`,
      );
    }
    const Tensor = this.Tensor;
    const input = new Tensor("float32", window, [1, SILERO_WINDOW_16K]);
    const state = new Tensor("float32", this.state, [...SILERO_STATE_SHAPE]);
    const sr = new Tensor("int64", BigInt64Array.from([16_000n]), []);
    const out = await this.session.run({ input, state, sr });
    const prob = out.output?.data;
    const nextState = out.stateN?.data;
    if (!(prob instanceof Float32Array)) {
      throw new Error(
        "[voice] SileroVad: model output 'output' was not float32",
      );
    }
    if (nextState instanceof Float32Array) {
      this.state = nextState;
    }
    return prob[0] ?? 0;
  }
}

/**
 * Native libelizainference-backed Silero VAD. It implements the same
 * narrow interface as the ONNX wrapper so `VadDetector` remains backend
 * agnostic: one 512-sample 16 kHz window in, one speech probability out.
 */
export class NativeSileroVad {
  readonly sampleRate: number;
  readonly windowSamples = SILERO_WINDOW_16K;
  private closed = false;

  private constructor(
    private readonly ffi: ElizaInferenceFfi,
    private readonly handle: NativeVadHandle,
    sampleRate: number,
  ) {
    this.sampleRate = sampleRate;
  }

  static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
    if (!ffi || typeof ffi.vadSupported !== "function") return false;
    return ffi.vadSupported();
  }

  static async load(opts: {
    ffi: ElizaInferenceFfi;
    ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
    sampleRate?: number;
  }): Promise<NativeSileroVad> {
    const sampleRate = opts.sampleRate ?? 16_000;
    validateSileroSampleRate(sampleRate);
    if (!NativeSileroVad.isSupported(opts.ffi)) {
      throw new VadUnavailableError(
        "model-missing",
        "[voice] Native Silero VAD is not supported by this libelizainference build.",
      );
    }
    if (
      !opts.ffi.vadOpen ||
      !opts.ffi.vadProcess ||
      !opts.ffi.vadReset ||
      !opts.ffi.vadClose
    ) {
      throw new VadUnavailableError(
        "model-load-failed",
        "[voice] Native Silero VAD support probe succeeded, but the required VAD FFI methods are missing.",
      );
    }
    const ctx = typeof opts.ctx === "function" ? opts.ctx() : opts.ctx;
    const handle = opts.ffi.vadOpen({ ctx, sampleRateHz: sampleRate });
    return new NativeSileroVad(opts.ffi, handle, sampleRate);
  }

  async process(window: Float32Array): Promise<number> {
    if (this.closed) {
      throw new Error("[voice] NativeSileroVad.process called after close()");
    }
    if (window.length !== SILERO_WINDOW_16K) {
      throw new Error(
        `[voice] NativeSileroVad.process expects a ${SILERO_WINDOW_16K}-sample window; got ${window.length}`,
      );
    }
    const vadProcess = this.ffi.vadProcess;
    if (!vadProcess) {
      throw new Error("[voice] NativeSileroVad.process missing FFI method");
    }
    return vadProcess({ vad: this.handle, pcm: window });
  }

  reset(): void {
    if (!this.closed) {
      const vadReset = this.ffi.vadReset;
      if (!vadReset) {
        throw new Error("[voice] NativeSileroVad.reset missing FFI method");
      }
      vadReset(this.handle);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const vadClose = this.ffi.vadClose;
    if (!vadClose) {
      throw new Error("[voice] NativeSileroVad.close missing FFI method");
    }
    vadClose(this.handle);
  }
}

// ---------------------------------------------------------------------------
// Tier 1: cheap always-on RMS energy gate.
// ---------------------------------------------------------------------------

export interface RmsEnergyGateConfig {
  /** RMS above this counts as activity. Default 0.012 — between the 0.01 the
   *  vision capture stream uses and the 0.05 Discord uses for speaking. */
  riseThreshold?: number;
  /** RMS must drop below this to count as quiet (hysteresis). Default
   *  `0.6 * riseThreshold`. */
  fallThreshold?: number;
  /** Consecutive ms below `fallThreshold` before emitting `energy-fall`.
   *  Default 200 ms. */
  fallHoldMs?: number;
}

export function rms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

/**
 * Hysteretic RMS gate. Feed it `PcmFrame`s; it emits `energy-rise` on the
 * first frame above `riseThreshold` and `energy-fall` after RMS has been
 * below `fallThreshold` for `fallHoldMs`. This is the fast pre-warm trigger
 * — not a speech detector.
 */
export class RmsEnergyGate {
  private readonly riseThreshold: number;
  private readonly fallThreshold: number;
  private readonly fallHoldMs: number;
  private active = false;
  private quietSinceMs: number | null = null;
  private readonly listeners = new Set<EnergyGateListener>();

  constructor(config: RmsEnergyGateConfig = {}) {
    this.riseThreshold = config.riseThreshold ?? 0.012;
    this.fallThreshold = config.fallThreshold ?? this.riseThreshold * 0.6;
    this.fallHoldMs = config.fallHoldMs ?? 200;
  }

  get isActive(): boolean {
    return this.active;
  }

  onEvent(listener: EnergyGateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns the frame RMS so callers can reuse it. */
  push(frame: PcmFrame): number {
    const level = rms(frame.pcm);
    if (!this.active) {
      if (level >= this.riseThreshold) {
        this.active = true;
        this.quietSinceMs = null;
        this.emit({
          type: "energy-rise",
          timestampMs: frame.timestampMs,
          rms: level,
        });
      }
      return level;
    }
    // active
    if (level < this.fallThreshold) {
      if (this.quietSinceMs === null) this.quietSinceMs = frame.timestampMs;
      const quietMs = frame.timestampMs - this.quietSinceMs;
      if (quietMs >= this.fallHoldMs) {
        this.active = false;
        this.quietSinceMs = null;
        this.emit({
          type: "energy-fall",
          timestampMs: frame.timestampMs,
          quietMs,
        });
      }
    } else {
      this.quietSinceMs = null;
    }
    return level;
  }

  reset(): void {
    this.active = false;
    this.quietSinceMs = null;
  }

  private emit(event: EnergyGateEvent): void {
    for (const l of this.listeners) l(event);
  }
}

// ---------------------------------------------------------------------------
// Tier 2 driver: VadDetector — the Silero speech state machine.
// ---------------------------------------------------------------------------

export interface VadDetectorConfig {
  /** Mic sample rate (Hz). MUST be 16 000 — Silero v5 is 16 kHz only. */
  sampleRate?: number;
  /** Speech probability above this opens a speech segment. Default 0.5. */
  onsetThreshold?: number;
  /** Speech probability must drop below this to count toward end-of-speech.
   *  Default `onsetThreshold - 0.15`. Below the onset to avoid flapping. */
  offsetThreshold?: number;
  /** Consecutive ms of speech-prob below `offsetThreshold` before the
   *  segment is considered *paused* (kick speculative response). Default
   *  100 ms (lowered from 220ms; further reduction gated on semantic EOT
   *  classifier V2). Override via `MILADY_PAUSE_HANGOVER_MS`. */
  pauseHangoverMs?: number;
  /**
   * V1 — "fast endpoint" pause hangover, used when `fastEndpointEnabled`
   * is true. Default 100 ms — short enough that a clean trailing-off
   * end-of-utterance hits the speculative path quickly, but long enough
   * to ride out mid-sentence micro-pauses. Gated by the flag so callers
   * can opt in once they've validated the false-positive rate on their
   * hardware. Default 100 ms.
   */
  fastPauseHangoverMs?: number;
  /**
   * V1 — when true, use `fastPauseHangoverMs` instead of `pauseHangoverMs`.
   * Default false until the streaming-ASR fast path (V2) ships.
   */
  fastEndpointEnabled?: boolean;
  /** Consecutive ms paused before the segment *ends* (finalize the turn).
   *  Default 700 ms. Must be ≥ `pauseHangoverMs`. */
  endHangoverMs?: number;
  /** A segment shorter than this (from onset to end) is reclassified as a
   *  `blip` rather than `speech-end`. Default 250 ms. */
  minSpeechMs?: number;
  /** Interval between `speech-active` heartbeats while speaking. Default
   *  200 ms. */
  activeHeartbeatMs?: number;
  /**
   * V4 — adaptive pause hangover. When the windowed RMS is in a sharp
   * downward trend across the last few frames (the user audibly trailed
   * off rather than stopping mid-thought), the hangover used to detect a
   * pause is scaled by this factor (clamped to a minimum). Default 0.5
   * (halve the hangover); set to 1.0 to disable.
   */
  adaptiveHangoverScaleOnDrop?: number;
  /**
   * V4 — minimum hangover the adaptive scale is allowed to produce, ms.
   * Default 50 ms. Prevents a steep drop from collapsing the hangover to
   * zero and emitting a pause on a single quiet frame.
   */
  adaptiveHangoverFloorMs?: number;
  /**
   * V4 — energy derivative (ΔRMS over the V4 history window) below this
   * value, combined with RMS below `offsetThreshold`, counts as "audibly
   * trailed off". Default -0.02 (negative slope: RMS dropping at least
   * 0.02 / window).
   */
  adaptiveHangoverDropThreshold?: number;
  /** RMS gate config (tier 1). */
  energyGate?: RmsEnergyGateConfig;
}

type SegmentPhase = "idle" | "speaking" | "paused";

export interface VadLike {
  readonly windowSamples: number;
  readonly sampleRate: number;
  process(window: Float32Array): Promise<number>;
  reset(): void;
}

export type VadProviderId = "qwen-toolkit" | "silero-native" | "silero-onnx";
export type VadProviderPreference = "auto" | VadProviderId;

export interface QwenToolkitVadAdapter {
  isAvailable?(): boolean | Promise<boolean>;
  loadVad(opts: { sampleRate: number }): Promise<VadLike>;
}

export interface ResolvedVadProvider {
  id: VadProviderId;
  vad: VadLike;
}

export interface CreateVadDetectorOptions {
  modelPath?: string;
  bundleRoot?: string;
  ffi?: ElizaInferenceFfi | null;
  ctx?: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
  qwenToolkitVad?: QwenToolkitVadAdapter | null;
  config?: VadDetectorConfig;
  prefer?: VadProviderPreference;
}

export function vadProviderOrder(
  prefer: VadProviderPreference = "auto",
): VadProviderId[] {
  if (prefer !== "auto") return [prefer];
  return ["qwen-toolkit", "silero-native", "silero-onnx"];
}

export async function resolveVadProvider(
  opts: CreateVadDetectorOptions = {},
): Promise<ResolvedVadProvider> {
  const sampleRate = opts.config?.sampleRate ?? 16_000;
  const tried: string[] = [];

  for (const provider of vadProviderOrder(opts.prefer)) {
    switch (provider) {
      case "qwen-toolkit": {
        tried.push(provider);
        if (!opts.qwenToolkitVad) break;
        const available = (await opts.qwenToolkitVad.isAvailable?.()) ?? true;
        if (!available) break;
        return {
          id: provider,
          vad: await opts.qwenToolkitVad.loadVad({ sampleRate }),
        };
      }
      case "silero-native": {
        tried.push(provider);
        if (!opts.ffi || !opts.ctx || !NativeSileroVad.isSupported(opts.ffi)) {
          break;
        }
        return {
          id: provider,
          vad: await NativeSileroVad.load({
            ffi: opts.ffi,
            ctx: opts.ctx,
            sampleRate,
          }),
        };
      }
      case "silero-onnx": {
        tried.push(provider);
        return {
          id: provider,
          vad: await SileroVad.load({
            modelPath: opts.modelPath,
            bundleRoot: opts.bundleRoot,
            sampleRate,
          }),
        };
      }
    }
  }

  throw new VadUnavailableError(
    "provider-missing",
    `[voice] No VAD provider available. Tried: ${tried.join(", ")}.`,
  );
}

/**
 * The authoritative VAD. Owns a model VAD provider (or any `VadLike` for tests),
 * an `RmsEnergyGate`, and the speech state machine. `pushFrame()` accepts
 * mic frames of any length ≥ 1 sample; internally it re-windows to the
 * provider's fixed sample window. Emits `VadEvent`s on the VAD timeline and
 * `EnergyGateEvent`s on the fast timeline.
 *
 * Frame ingestion is serialized (`pushFrame` awaits the model forward pass)
 * so events stay in order; callers that can't await may fire-and-forget — a
 * dropped-frame counter (`droppedFrames`) records overruns.
 */
export class VadDetector {
  readonly silero: VadLike;
  readonly energyGate: RmsEnergyGate;
  private readonly sampleRate: number;
  private readonly onsetThreshold: number;
  private readonly offsetThreshold: number;
  private readonly pauseHangoverMs: number;
  private readonly fastPauseHangoverMs: number;
  private readonly fastEndpointEnabled: boolean;
  private readonly endHangoverMs: number;
  private readonly minSpeechMs: number;
  private readonly activeHeartbeatMs: number;
  // V4 — adaptive hangover state.
  private readonly adaptiveHangoverScaleOnDrop: number;
  private readonly adaptiveHangoverFloorMs: number;
  private readonly adaptiveHangoverDropThreshold: number;
  // Rolling RMS history (last 3 windows ≈ 96 ms @ 16 kHz / 512). The
  // sample-rate-of-drop check reads from this each window.
  private readonly recentRms: number[] = [];
  private static readonly RECENT_RMS_HISTORY = 3;

  private readonly vadListeners = new Set<VadEventListener>();

  private pending: Float32Array = new Float32Array(0);
  private windowDurationMs: number;
  private clockMs = 0; // timestamp of the *next* unconsumed sample
  private busy: Promise<void> = Promise.resolve();
  droppedFrames = 0;

  private phase: SegmentPhase = "idle";
  private speechStartMs = 0;
  private lastSpeechMs = 0; // last window whose prob ≥ offsetThreshold
  private pauseStartedMs = 0;
  private lastHeartbeatMs = 0;
  private peakRmsInSegment = 0;

  constructor(silero: VadLike, config: VadDetectorConfig = {}) {
    this.silero = silero;
    this.sampleRate = config.sampleRate ?? silero.sampleRate ?? 16_000;
    if (this.sampleRate !== silero.sampleRate) {
      throw new Error(
        `[voice] VadDetector sample rate ${this.sampleRate} != Silero model rate ${silero.sampleRate}`,
      );
    }
    this.onsetThreshold = config.onsetThreshold ?? 0.5;
    this.offsetThreshold =
      config.offsetThreshold ?? Math.max(0.1, this.onsetThreshold - 0.15);
    // Lowered from 220ms; further reduction gated on semantic EOT classifier (V2).
    // Override via MILADY_PAUSE_HANGOVER_MS env var.
    this.pauseHangoverMs =
      config.pauseHangoverMs ?? readPauseHangoverMsEnv() ?? 100;
    this.fastPauseHangoverMs = config.fastPauseHangoverMs ?? 100;
    this.fastEndpointEnabled = config.fastEndpointEnabled ?? false;
    this.endHangoverMs = Math.max(
      this.fastEndpointEnabled
        ? this.fastPauseHangoverMs
        : this.pauseHangoverMs,
      config.endHangoverMs ?? 700,
    );
    this.minSpeechMs = config.minSpeechMs ?? 250;
    this.activeHeartbeatMs = config.activeHeartbeatMs ?? 200;
    this.adaptiveHangoverScaleOnDrop = Math.max(
      0.1,
      Math.min(1, config.adaptiveHangoverScaleOnDrop ?? 0.5),
    );
    this.adaptiveHangoverFloorMs = Math.max(
      0,
      config.adaptiveHangoverFloorMs ?? 50,
    );
    this.adaptiveHangoverDropThreshold =
      config.adaptiveHangoverDropThreshold ?? -0.02;
    this.energyGate = new RmsEnergyGate(config.energyGate);
    this.windowDurationMs = (silero.windowSamples / this.sampleRate) * 1000;
  }

  /**
   * Effective pause hangover for this window. Starts from
   * `fastPauseHangoverMs` or `pauseHangoverMs` (V1: gated on
   * `fastEndpointEnabled`), then optionally scales it down when the RMS
   * trajectory shows an audible trail-off (V4).
   */
  private effectivePauseHangoverMs(): number {
    const base = this.fastEndpointEnabled
      ? this.fastPauseHangoverMs
      : this.pauseHangoverMs;
    if (this.adaptiveHangoverScaleOnDrop >= 1) return base;
    // V4 — need at least two samples to compute a slope.
    if (this.recentRms.length < 2) return base;
    const first = this.recentRms[0];
    const last = this.recentRms[this.recentRms.length - 1];
    // Slope per window (we sample once per window). Negative = trailing off.
    const slope = (last - first) / (this.recentRms.length - 1);
    const lastBelowOffset = last < this.offsetThreshold;
    if (slope <= this.adaptiveHangoverDropThreshold && lastBelowOffset) {
      return Math.max(
        this.adaptiveHangoverFloorMs,
        base * this.adaptiveHangoverScaleOnDrop,
      );
    }
    return base;
  }

  onVadEvent(listener: VadEventListener): () => void {
    this.vadListeners.add(listener);
    return () => this.vadListeners.delete(listener);
  }

  onEnergyEvent(listener: EnergyGateListener): () => void {
    return this.energyGate.onEvent(listener);
  }

  /** True while a speech segment (incl. its pause hangover) is open. */
  get inSpeech(): boolean {
    return this.phase !== "idle";
  }

  /**
   * Feed a mic frame. Returns a promise that resolves once every full
   * Silero window contained in (the accumulated buffer up to) this frame
   * has been processed and its events emitted. The fast RMS gate fires
   * synchronously before the await.
   */
  pushFrame(frame: PcmFrame): Promise<void> {
    if (frame.sampleRate !== this.sampleRate) {
      return Promise.reject(
        new Error(
          `[voice] VadDetector expects ${this.sampleRate} Hz frames; got ${frame.sampleRate}. Resample upstream of the VAD.`,
        ),
      );
    }
    // Tier 1: synchronous, no model.
    this.energyGate.push(frame);

    // Anchor the clock to the first frame so timestamps are mic-domain.
    if (this.pending.length === 0 && this.clockMs === 0) {
      this.clockMs = frame.timestampMs;
    }
    // Append to the re-windowing buffer.
    const merged = new Float32Array(this.pending.length + frame.pcm.length);
    merged.set(this.pending, 0);
    merged.set(frame.pcm, this.pending.length);
    this.pending = merged;

    const run = this.busy.then(() => this.drainWindows());
    // Keep the chain alive even if a window throws (the throw still
    // surfaces via the returned promise).
    this.busy = run.catch(() => {
      this.droppedFrames++;
    });
    return run;
  }

  /** Flush any partial trailing samples (zero-padded to a full window) and
   *  finalize an open segment. Call at end-of-stream. */
  async flush(): Promise<void> {
    await this.busy;
    if (this.pending.length > 0) {
      const w = new Float32Array(this.silero.windowSamples);
      w.set(this.pending.subarray(0, this.silero.windowSamples));
      this.pending = new Float32Array(0);
      await this.processWindow(w);
    }
    if (this.phase !== "idle") {
      this.endSegment(this.clockMs);
    }
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.clockMs = 0;
    this.phase = "idle";
    this.peakRmsInSegment = 0;
    this.recentRms.length = 0;
    this.silero.reset();
    this.energyGate.reset();
  }

  private async drainWindows(): Promise<void> {
    const win = this.silero.windowSamples;
    while (this.pending.length >= win) {
      const w = this.pending.subarray(0, win);
      // Copy out so the slice is stable across the await.
      const window = w.slice();
      this.pending = this.pending.subarray(win);
      await this.processWindow(window);
    }
  }

  private async processWindow(window: Float32Array): Promise<void> {
    const prob = await this.silero.process(window);
    const windowRms = rms(window);
    // V4 — keep a short rolling RMS history for the energy-rate-of-drop
    // adaptive hangover. Three windows ≈ 96 ms at 16 kHz / 512 samples.
    this.recentRms.push(windowRms);
    if (this.recentRms.length > VadDetector.RECENT_RMS_HISTORY) {
      this.recentRms.shift();
    }
    // Clock at the *end* of this window.
    this.clockMs += this.windowDurationMs;
    const now = this.clockMs;
    const isSpeechFrame = prob >= this.onsetThreshold;
    const aboveOffset = prob >= this.offsetThreshold;

    switch (this.phase) {
      case "idle": {
        if (isSpeechFrame) {
          this.phase = "speaking";
          this.speechStartMs = now - this.windowDurationMs;
          this.lastSpeechMs = now;
          this.lastHeartbeatMs = now;
          this.peakRmsInSegment = windowRms;
          this.emit({
            type: "speech-start",
            timestampMs: this.speechStartMs,
            probability: prob,
          });
        }
        break;
      }
      case "speaking": {
        this.peakRmsInSegment = Math.max(this.peakRmsInSegment, windowRms);
        if (aboveOffset) {
          this.lastSpeechMs = now;
        }
        const quietMs = now - this.lastSpeechMs;
        if (quietMs >= this.effectivePauseHangoverMs()) {
          this.phase = "paused";
          this.pauseStartedMs = this.lastSpeechMs;
          this.emit({
            type: "speech-pause",
            timestampMs: now,
            pauseDurationMs: quietMs,
          });
        } else if (now - this.lastHeartbeatMs >= this.activeHeartbeatMs) {
          this.lastHeartbeatMs = now;
          this.emit({
            type: "speech-active",
            timestampMs: now,
            probability: prob,
            speechDurationMs: now - this.speechStartMs,
          });
        }
        break;
      }
      case "paused": {
        this.peakRmsInSegment = Math.max(this.peakRmsInSegment, windowRms);
        if (isSpeechFrame) {
          // Speech resumed before end-of-utterance.
          this.phase = "speaking";
          this.lastSpeechMs = now;
          this.lastHeartbeatMs = now;
          this.emit({
            type: "speech-active",
            timestampMs: now,
            probability: prob,
            speechDurationMs: now - this.speechStartMs,
          });
        } else {
          const pauseMs = now - this.pauseStartedMs;
          if (pauseMs >= this.endHangoverMs) {
            this.endSegment(now);
          } else {
            this.emit({
              type: "speech-pause",
              timestampMs: now,
              pauseDurationMs: pauseMs,
            });
          }
        }
        break;
      }
    }
  }

  private endSegment(now: number): void {
    const speechDurationMs = this.lastSpeechMs - this.speechStartMs;
    const peakRms = this.peakRmsInSegment;
    this.phase = "idle";
    this.peakRmsInSegment = 0;
    this.silero.reset();
    if (speechDurationMs < this.minSpeechMs) {
      this.emit({
        type: "blip",
        timestampMs: now,
        durationMs: Math.max(0, speechDurationMs),
        peakRms,
      });
      return;
    }
    this.emit({ type: "speech-end", timestampMs: now, speechDurationMs });
  }

  private emit(event: VadEvent): void {
    for (const l of this.vadListeners) l(event);
  }
}

/**
 * Back-compat wrapper for callers that still use the old Silero-specific
 * helper name. It now goes through the full provider resolver.
 */
export async function createSileroVadDetector(
  opts: CreateVadDetectorOptions = {},
): Promise<VadDetector> {
  return createVadDetector(opts);
}

/**
 * Convenience: resolve the best available model VAD provider and wrap it in a
 * `VadDetector`.
 */
export async function createVadDetector(
  opts: CreateVadDetectorOptions = {},
): Promise<VadDetector> {
  const { vad } = await resolveVadProvider(opts);
  return new VadDetector(vad, opts.config);
}

/**
 * Read `MILADY_PAUSE_HANGOVER_MS` from the environment. Returns a positive
 * integer when the variable is set and valid, otherwise `undefined`.
 */
function readPauseHangoverMsEnv(): number | undefined {
  const raw = process.env["MILADY_PAUSE_HANGOVER_MS"]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
