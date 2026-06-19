/**
 * WebView → agent PCM pump for live on-device speaker diarization.
 *
 * The Android native AudioRecord path (`plugin-native-talkmode`) streams raw
 * 16 kHz mono PCM as `audioFrame` Capacitor events into the WebView, but the
 * bun:ffi voice models (Silero VAD, WeSpeaker encoder, pyannote diarizer) only
 * run in the embedded bun agent process. This pump closes that gap:
 *
 *   startAudioFrames() → `audioFrame` events → batch (~49 fps) →
 *     POST /api/voice/audio-frames → agent AudioFrameConsumer → diarized turns
 *
 * Frames are batched (not one HTTP request per frame) because the native side
 * emits ~49 frames/s; a per-frame POST would be wasteful and lossy. The pump
 * flushes on a fixed interval or when the buffer hits a size cap, and sends a
 * final `flush:true` batch on stop so a trailing utterance is not lost.
 *
 * The agent base URL (loopback) is routed through the Android native-agent
 * fetch bridge (`installAndroidNativeAgentFetchBridge`), so a plain `fetch`
 * reaches the on-device agent over IPC without bespoke transport plumbing.
 */

import type {
  TalkModeAudioFrameEvent,
  TalkModePluginLike,
} from "../bridge/native-plugins";
import { MOBILE_LOCAL_AGENT_API_BASE } from "../first-run/mobile-runtime-mode";

const AUDIO_FRAMES_PATH = "/api/voice/audio-frames";

/** Max frames buffered before a flush is forced (≈ 1 s at 20 ms frames). */
const MAX_BATCH_FRAMES = 49;
/** Flush cadence in ms (a partial batch is sent even below the size cap). */
const FLUSH_INTERVAL_MS = 250;

export interface AudioFramePumpOptions {
  /** Agent base URL. Defaults to the loopback on-device agent. */
  agentBaseUrl?: string;
  /** Capture sample rate (Hz). Default 16000 — the rate every voice model wants. */
  sampleRate?: number;
  /** Frame duration in ms. Default 20 ms (320 samples @ 16 kHz). */
  frameMs?: number;
}

export interface AudioFramePumpStartResult {
  started: boolean;
  suspendedStt?: boolean;
  error?: string;
}

interface AgentFramesResponse {
  ok?: boolean;
  framesReceived?: number;
  turnsObserved?: number;
}

/**
 * Drives the Android `audioFrame` → batched-POST → agent diarization pipeline.
 * One instance per capture session. Native-only: `start` no-ops cleanly on a
 * plugin without `startAudioFrames` (web/desktop).
 */
export class AudioFramePump {
  private readonly plugin: TalkModePluginLike;
  private readonly agentBaseUrl: string;
  private readonly sampleRate: number;
  private readonly frameMs: number;

  private removeListener: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private buffer: TalkModeAudioFrameEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private running = false;
  /** Cumulative frames captured + acked by the agent, for diagnostics. */
  framesSent = 0;
  framesAcked = 0;
  turnsObserved = 0;

  constructor(plugin: TalkModePluginLike, options: AudioFramePumpOptions = {}) {
    this.plugin = plugin;
    this.agentBaseUrl = options.agentBaseUrl ?? MOBILE_LOCAL_AGENT_API_BASE;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.frameMs = options.frameMs ?? 20;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Subscribe to `audioFrame`, start native capture, and begin pumping batches
   * to the agent. Returns the native capture result (whether STT was suspended).
   */
  async start(): Promise<AudioFramePumpStartResult> {
    if (this.running) return { started: true };
    if (typeof this.plugin.startAudioFrames !== "function") {
      return { started: false, error: "startAudioFrames not supported" };
    }
    const handle = await this.plugin.addListener(
      "audioFrame",
      (event: TalkModeAudioFrameEvent) => this.onFrame(event),
    );
    this.removeListener = () => {
      void handle.remove();
    };

    const result = await this.plugin.startAudioFrames({
      sampleRate: this.sampleRate,
      frameMs: this.frameMs,
    });
    if (!result.started) {
      this.removeListener?.();
      this.removeListener = null;
      return { started: false, error: result.error };
    }

    this.running = true;
    this.flushTimer = setInterval(() => {
      void this.flush(false);
    }, FLUSH_INTERVAL_MS);
    return { started: true, suspendedStt: result.suspendedStt };
  }

  /** Stop native capture, flush the tail, and detach the listener. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof this.plugin.stopAudioFrames === "function") {
      await this.plugin.stopAudioFrames();
    }
    this.removeListener?.();
    this.removeListener = null;
    await this.flush(true);
    await this.sending;
  }

  private onFrame(event: TalkModeAudioFrameEvent): void {
    if (!this.running) return;
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH_FRAMES) void this.flush(false);
  }

  /** Send the buffered batch to the agent. Serialized so batches stay ordered. */
  private async flush(final: boolean): Promise<void> {
    if (this.buffer.length === 0 && !final) return;
    const frames = this.buffer;
    this.buffer = [];
    this.sending = this.sending.then(() => this.post(frames, final));
    return this.sending;
  }

  private async post(
    frames: TalkModeAudioFrameEvent[],
    final: boolean,
  ): Promise<void> {
    if (frames.length === 0 && !final) return;
    const res = await fetch(`${this.agentBaseUrl}${AUDIO_FRAMES_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames, flush: final }),
    });
    if (!res.ok) {
      throw new Error(
        `[audio-frame-pump] agent rejected batch: ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as AgentFramesResponse;
    this.framesSent += frames.length;
    if (typeof json.framesReceived === "number") {
      this.framesAcked = json.framesReceived;
    }
    if (typeof json.turnsObserved === "number") {
      this.turnsObserved = json.turnsObserved;
    }
  }
}
