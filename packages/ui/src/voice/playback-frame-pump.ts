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

const WORKLET_SOURCE = `
class ElizaPlaybackReferenceTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] || [];
    const first = input[0];
    if (first && first.length > 0) {
      const mono = new Float32Array(first.length);
      const channels = Math.max(1, input.length);
      for (let i = 0; i < first.length; i += 1) {
        let sum = 0;
        let count = 0;
        for (let ch = 0; ch < channels; ch += 1) {
          const channel = input[ch];
          if (channel) {
            sum += channel[i] || 0;
            count += 1;
          }
        }
        mono[i] = count > 0 ? sum / count : 0;
      }
      this.port.postMessage({ pcm: mono, sampleRate }, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", ElizaPlaybackReferenceTap);
`;

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
    typeof AudioWorkletNode !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

async function ensurePlaybackWorklet(ctx: AudioContext): Promise<void> {
  const existing = workletModules.get(ctx);
  if (existing) return existing;

  const pending = (async () => {
    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  workletModules.set(ctx, pending);
  return pending;
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
          /* ok */
        }
        try {
          node.disconnect();
        } catch {
          /* ok */
        }
        try {
          silentGain.disconnect();
        } catch {
          /* ok */
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
    return session;
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
