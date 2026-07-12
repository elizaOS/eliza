/**
 * Web Audio -> agent playback-reference pump for live echo cancellation.
 *
 * The live diarization route accepts the agent's own TTS playback as far-end
 * reference frames at `/api/voice/playback-frames`. This helper taps decoded
 * Web Audio playback in real time, downmixes/resamples to 16 kHz mono, encodes
 * 20 ms LE-s16 frames, and posts them in batches. The route is optional: a
 * missing local diarization backend must never break audible TTS playback.
 */

import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";
import { ttsDebug } from "../utils/tts-debug";
import { resolveAudioWorkletModuleUrl } from "./audio-worklet-module-urls";
import {
  markTtsPlaybackEnded,
  markTtsPlaybackStarted,
} from "./tts-playback-activity";

const PLAYBACK_FRAMES_PATH = "/api/voice/playback-frames";
const TARGET_SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const MAX_BATCH_FRAMES = 49;
const FLUSH_INTERVAL_MS = 250;
const WORKLET_NAME = "eliza-playback-reference-tap";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PlaybackAudioFrameEvent {
  pcm16: string;
  sampleRate: number;
  channels: 1;
  samples: number;
  rms: number;
  timestamp: number;
  frameIndex: number;
}

export interface PlaybackFramePumpOptions {
  endpointPath?: string;
  targetSampleRate?: number;
  frameMs?: number;
  maxBatchFrames?: number;
  flushIntervalMs?: number;
  nowMs?: () => number;
  fetcher?: FetchLike;
}

export interface PlaybackFrameTap {
  /** Worklet taps may join playback in progress; scheduled fallbacks may not. */
  readonly lateAttachSafe?: boolean;
  start(startTimestampMs?: number): void;
  stop(options?: { reset?: boolean; drain?: boolean }): Promise<void>;
}

interface WorkletChunk {
  pcm?: Float32Array;
  sampleRate?: number;
}

const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();

function getNowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function hasAudioWorklet(ctx: AudioContext): boolean {
  return (
    typeof ctx.audioWorklet?.addModule === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

async function ensurePlaybackWorklet(ctx: AudioContext): Promise<void> {
  const existing = workletModules.get(ctx);
  if (existing) return existing;

  const pending = ctx.audioWorklet.addModule(
    resolveAudioWorkletModuleUrl("playback-reference"),
  );
  workletModules.set(ctx, pending);
  return pending;
}

/** Best-effort preload so the first reply does not pay worklet setup inline. */
export function warmPlaybackWorklet(ctx: AudioContext): void {
  if (!hasAudioWorklet(ctx)) return;
  void ensurePlaybackWorklet(ctx).catch(() => {
    // error-policy:J6 The visualizer is optional and tapSource can degrade.
  });
}

function isPlaybackContextRunning(ctx: AudioContext): boolean {
  return ctx.state === "running";
}

/**
 * Resumes a suspended or interrupted AudioContext with a timeout, so a
 * `resume()` call that never settles (observed on some mobile WebViews) cannot
 * block playback forever. Returns whether the context is running afterward.
 */
export async function resumeAudioContextForPlayback(
  ctx: AudioContext,
  timeoutMs = 1200,
): Promise<boolean> {
  if (isPlaybackContextRunning(ctx)) return true;
  if (ctx.state !== "suspended" && ctx.state !== "interrupted") return false;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const resumed = await Promise.race([
      ctx.resume().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return resumed && isPlaybackContextRunning(ctx);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Shared resume-or-fail-closed gate the three TTS provider paths in
 * `useVoiceChat` each duplicated. Returns normally once `ctx` is running;
 * throws `NotAllowedError` (and reports via `onBlocked`) if a browser
 * autoplay gesture is still required, so the caller fails closed instead of
 * silently playing nothing.
 */
export async function ensurePlaybackContextRunning(
  ctx: AudioContext,
  provider: string,
  onBlocked: () => void,
): Promise<void> {
  if (isPlaybackContextRunning(ctx)) return;
  const resumed = await resumeAudioContextForPlayback(ctx);
  if (resumed) return;
  ttsDebug("play:audio-context-blocked", { provider, state: ctx.state });
  onBlocked();
  throw new DOMException(
    "Audio playback is blocked until a user gesture unlocks the audio context",
    "NotAllowedError",
  );
}

/**
 * Wait briefly for the optional visualizer tap without allowing a slow worklet
 * module load to gate audible playback.
 */
export async function attachPlaybackTapWithGrace(
  tapPromise: Promise<PlaybackFrameTap | null>,
  onLateTap: (tap: PlaybackFrameTap) => void,
  graceMs = 150,
): Promise<PlaybackFrameTap | null> {
  const timeout = Symbol("playback-tap-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    tapPromise,
    new Promise<typeof timeout>((resolve) => {
      timeoutId = setTimeout(() => resolve(timeout), graceMs);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (result !== timeout) return result;

  void tapPromise.then((tap) => {
    // A scheduled-buffer fallback starts at offset zero and would send stale
    // reference frames if joined mid-clip. Only live worklet taps are safe.
    if (tap?.lateAttachSafe) onLateTap(tap);
  });
  return null;
}

/**
 * Owns one playback-reference tap's lifecycle across the grace-window attach,
 * a possible late (post-grace) attach, and teardown. `useVoiceChat` drove this
 * as three near-identical inline blocks (one per TTS provider path); this
 * class is the single implementation those call sites now share, matching
 * `activeTapRef` (the hook's `playbackFrameTapRef`) to whichever tap instance
 * is currently live so a stale reference can never be started/stopped twice.
 */
export class PlaybackTapLifecycle {
  private tap: PlaybackFrameTap | null = null;
  private started = false;
  private finished = false;

  constructor(
    private readonly activeTapRef: { current: PlaybackFrameTap | null },
  ) {}

  get current(): PlaybackFrameTap | null {
    return this.tap;
  }

  /** Races the tap against the grace window; a late-arriving worklet tap self-attaches via the callback below. */
  async attach(
    tapPromise: Promise<PlaybackFrameTap | null>,
  ): Promise<PlaybackFrameTap | null> {
    this.tap = await attachPlaybackTapWithGrace(tapPromise, (lateTap) => {
      if (this.finished) {
        void lateTap.stop({ reset: true }).catch((error) => {
          // error-policy:J6 Late reference-tap teardown cannot affect completed audio.
          ttsDebug("playback-reference:late-tap-stop-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      this.tap = lateTap;
      this.activeTapRef.current = lateTap;
      if (this.started) lateTap.start(getNowMs());
    });
    return this.tap;
  }

  /** Call once, immediately before `source.start(0)`. */
  start(startTimestampMs: number): void {
    this.started = true;
    if (this.tap) {
      this.activeTapRef.current = this.tap;
      this.tap.start(startTimestampMs);
    }
  }

  /** Call from the playback `finish()` teardown; best-effort, never throws. */
  finish(): void {
    this.finished = true;
    if (this.activeTapRef.current === this.tap) {
      this.activeTapRef.current = null;
    }
    void this.tap?.stop({ reset: true }).catch(() => {
      // error-policy:J6 best-effort teardown; playback has already ended.
    });
  }
}

function clampPcm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function encodePcm16Base64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    const clamped = clampPcm(pcm[i] ?? 0);
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, Math.round(int16), true);
  }

  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(bytes: Uint8Array): { toString(encoding: "base64"): string };
      };
    }
  ).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");

  const btoaFn = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!btoaFn) {
    throw new Error("[playback-frame-pump] no base64 encoder available");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoaFn(binary);
}

function measureRms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = clampPcm(pcm[i] ?? 0);
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / pcm.length);
}

export function downmixAudioBufferToMono(buffer: AudioBuffer): Float32Array {
  const channels = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < out.length; i += 1) {
      out[i] += (data[i] ?? 0) / channels;
    }
  }
  return out;
}

class StreamingLinearResampler {
  private readonly sourceRate: number;
  private readonly targetRate: number;
  private pending: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private sourcePosition = 0;

  constructor(sourceRate: number, targetRate: number) {
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    if (this.sourceRate === this.targetRate) return input.slice();

    const combined = new Float32Array(this.pending.length + input.length);
    combined.set(this.pending);
    combined.set(input, this.pending.length);

    const step = this.sourceRate / this.targetRate;
    const out: number[] = [];
    while (this.sourcePosition + 1 < combined.length) {
      const i0 = Math.floor(this.sourcePosition);
      const i1 = i0 + 1;
      const frac = this.sourcePosition - i0;
      const s0 = combined[i0] ?? 0;
      const s1 = combined[i1] ?? s0;
      out.push(s0 + (s1 - s0) * frac);
      this.sourcePosition += step;
    }

    const drop = Math.max(0, Math.floor(this.sourcePosition) - 1);
    this.pending = combined.slice(drop);
    this.sourcePosition -= drop;
    return Float32Array.from(out);
  }
}

export function resamplePcmTo16k(
  pcm: Float32Array,
  sourceSampleRate: number,
): Float32Array {
  return new StreamingLinearResampler(
    sourceSampleRate,
    TARGET_SAMPLE_RATE,
  ).push(pcm);
}

function concatFloat32(
  a: Float32Array<ArrayBufferLike>,
  b: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

class PlaybackFrameSession implements PlaybackFrameTap {
  private readonly endpointPath: string;
  private readonly targetSampleRate: number;
  private readonly frameMs: number;
  private readonly frameSamples: number;
  private readonly maxBatchFrames: number;
  private readonly flushIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly fetcher: FetchLike;
  private readonly disconnectTap: (() => void) | null;

  private resampler: StreamingLinearResampler | null = null;
  private resamplerRate = 0;
  private pending: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private batch: PlaybackAudioFrameEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private failed = false;
  private frameIndex = 0;
  private startTimestampMs = 0;

  constructor(
    options: Required<Omit<PlaybackFramePumpOptions, "fetcher" | "nowMs">> & {
      fetcher: FetchLike;
      nowMs: () => number;
      disconnectTap?: (() => void) | null;
    },
  ) {
    this.endpointPath = options.endpointPath;
    this.targetSampleRate = options.targetSampleRate;
    this.frameMs = options.frameMs;
    this.frameSamples = Math.round(
      (options.targetSampleRate * options.frameMs) / 1000,
    );
    this.maxBatchFrames = options.maxBatchFrames;
    this.flushIntervalMs = options.flushIntervalMs;
    this.nowMs = options.nowMs;
    this.fetcher = options.fetcher;
    this.disconnectTap = options.disconnectTap ?? null;
  }

  start(startTimestampMs = this.nowMs()): void {
    if (this.running) return;
    this.running = true;
    this.startTimestampMs = startTimestampMs;
    // The session brackets real audible playback — raise the capture-side
    // echo gate for its duration + cooldown (#12256 layer 1).
    markTtsPlaybackStarted();
    this.flushTimer = setInterval(() => {
      void this.flush(false);
    }, this.flushIntervalMs);
  }

  appendPcm(pcm: Float32Array, sampleRate: number): void {
    if (!this.running || this.failed || pcm.length === 0) return;
    if (!this.resampler || this.resamplerRate !== sampleRate) {
      this.resampler = new StreamingLinearResampler(
        sampleRate,
        this.targetSampleRate,
      );
      this.resamplerRate = sampleRate;
    }
    const resampled = this.resampler.push(pcm);
    this.pending = concatFloat32(this.pending, resampled);

    while (this.pending.length >= this.frameSamples) {
      const framePcm = this.pending.slice(0, this.frameSamples);
      this.pending = this.pending.slice(this.frameSamples);
      this.batch.push(this.buildFrame(framePcm));
      if (this.batch.length >= this.maxBatchFrames) {
        void this.flush(false);
      }
    }
  }

  async stop(
    options: { reset?: boolean; drain?: boolean } = {},
  ): Promise<void> {
    if (!this.running && !options.reset) return;
    if (this.running) markTtsPlaybackEnded(this.nowMs());
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.disconnectTap?.();
    await this.flush(false);
    await this.sending;
    if (options.reset) {
      await this.post([], true);
    }
  }

  private buildFrame(pcm: Float32Array): PlaybackAudioFrameEvent {
    const index = this.frameIndex;
    this.frameIndex += 1;
    return {
      pcm16: encodePcm16Base64(pcm),
      sampleRate: this.targetSampleRate,
      channels: 1,
      samples: pcm.length,
      rms: measureRms(pcm),
      timestamp: this.startTimestampMs + index * this.frameMs,
      frameIndex: index,
    };
  }

  private async flush(final: boolean): Promise<void> {
    if (this.batch.length === 0 && !final) return;
    const frames = this.batch;
    this.batch = [];
    this.sending = this.sending.then(() => this.post(frames, false));
    return this.sending;
  }

  private async post(
    frames: PlaybackAudioFrameEvent[],
    reset: boolean,
  ): Promise<void> {
    if (this.failed || (frames.length === 0 && !reset)) return;
    try {
      const res = await this.fetcher(resolveApiUrl(this.endpointPath), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(frames.length > 0 ? { frames } : {}),
          ...(reset ? { reset: true } : {}),
        }),
      });
      if (!res.ok) this.failed = true;
    } catch {
      // error-policy:J4 ship failure sets the `failed` flag the pump exposes;
      // the AEC consumer observes it instead of an exploded audio graph
      this.failed = true;
    }
  }
}

export class PlaybackFramePump {
  private readonly options: Required<
    Omit<PlaybackFramePumpOptions, "fetcher" | "nowMs">
  > & {
    fetcher: FetchLike;
    nowMs: () => number;
  };

  constructor(options: PlaybackFramePumpOptions = {}) {
    this.options = {
      endpointPath: options.endpointPath ?? PLAYBACK_FRAMES_PATH,
      targetSampleRate: options.targetSampleRate ?? TARGET_SAMPLE_RATE,
      frameMs: options.frameMs ?? FRAME_MS,
      maxBatchFrames: options.maxBatchFrames ?? MAX_BATCH_FRAMES,
      flushIntervalMs: options.flushIntervalMs ?? FLUSH_INTERVAL_MS,
      nowMs: options.nowMs ?? getNowMs,
      fetcher: options.fetcher ?? fetchWithCsrf,
    };
  }

  async tapSource(
    ctx: AudioContext,
    source: AudioNode,
    fallbackBuffer: AudioBuffer,
  ): Promise<PlaybackFrameTap | null> {
    // error-policy:J4 AudioWorklet unsupported/failed — fall back to the
    // scheduled-buffer session, which taps the same frames less precisely
    const workletSession = await this.createWorkletSession(ctx, source).catch(
      () => null,
    );
    if (workletSession) return workletSession;
    return this.createScheduledBufferSession(fallbackBuffer);
  }

  createSessionForTest(): PlaybackFrameTap & {
    appendPcm(pcm: Float32Array, sampleRate: number): void;
  } {
    return new PlaybackFrameSession(this.options);
  }

  private async createWorkletSession(
    ctx: AudioContext,
    source: AudioNode,
  ): Promise<PlaybackFrameTap | null> {
    if (!hasAudioWorklet(ctx)) return null;
    await ensurePlaybackWorklet(ctx);

    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    source.connect(node);
    node.connect(silentGain);
    silentGain.connect(ctx.destination);

    const session = new PlaybackFrameSession({
      ...this.options,
      disconnectTap: () => {
        node.port.onmessage = null;
        try {
          source.disconnect(node);
        } catch {
          // error-policy:J6 teardown — node may already be disconnected
        }
        try {
          node.disconnect();
        } catch {
          // error-policy:J6 teardown
        }
        try {
          silentGain.disconnect();
        } catch {
          // error-policy:J6 teardown
        }
      },
    });

    node.port.onmessage = (event: MessageEvent<WorkletChunk>) => {
      const pcm = event.data?.pcm;
      const sampleRate = event.data?.sampleRate;
      if (pcm instanceof Float32Array && typeof sampleRate === "number") {
        session.appendPcm(pcm, sampleRate);
      }
    };
    return Object.assign(session, { lateAttachSafe: true as const });
  }

  private createScheduledBufferSession(buffer: AudioBuffer): PlaybackFrameTap {
    const session = new PlaybackFrameSession(this.options);
    const sourceRate = buffer.sampleRate;
    const mono = downmixAudioBufferToMono(buffer);
    let offset = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const samplesPerTick = Math.max(
      1,
      Math.round((sourceRate * this.options.frameMs) / 1000),
    );

    return {
      start: (startTimestampMs?: number) => {
        session.start(startTimestampMs);
        timer = setInterval(() => {
          if (offset >= mono.length) {
            if (timer) clearInterval(timer);
            timer = null;
            return;
          }
          const next = mono.slice(offset, offset + samplesPerTick);
          offset += samplesPerTick;
          session.appendPcm(next, sourceRate);
        }, this.options.frameMs);
      },
      stop: async (options?: { reset?: boolean; drain?: boolean }) => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (options?.drain !== false) {
          while (offset < mono.length) {
            const next = mono.slice(offset, offset + samplesPerTick);
            offset += samplesPerTick;
            session.appendPcm(next, sourceRate);
          }
        }
        await session.stop(options);
      },
    };
  }
}
