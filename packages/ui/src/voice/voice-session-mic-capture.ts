/**
 * Mic capture for the realtime voice-session client.
 *
 * getUserMedia → AudioWorklet (fallback ScriptProcessor for WebView 113) →
 * Float32 → Int16 LE PCM (16 kHz mono) → onFrame(bytes).
 *
 * WebView 113 gotchas this handles:
 *   - AudioWorklet availability is VERIFIED at runtime (not assumed); a runtime
 *     without `audioWorklet.addModule` / `AudioWorkletNode` falls back to a
 *     ScriptProcessorNode. WebView 113 has AudioWorklet, but a hardened/embedded
 *     WebView can have it disabled, so we probe, never assume.
 *   - The AudioContext may open at a device-native rate (44.1/48 kHz). We resample
 *     to 16 kHz mono before framing so the uplink matches the negotiated pcm16
 *     16 kHz contract exactly (the server does NOT resample).
 *   - iOS PWA suspends the page/AudioContext aggressively on background. On
 *     `visibilitychange` to hidden we PAUSE capture and notify (`onSuspend`)
 *     rather than silently dropping frames; on return we resume.
 *   - Permission denial surfaces as a typed error, never a silent no-op.
 *
 * The capture is transport-agnostic: it only emits Int16 PCM byte frames via
 * `onFrame`. The client wires those to the WS uplink. Tests inject a fake
 * AudioContext + getUserMedia to exercise the real framing/resample/suspend
 * code (no stub of the thing under test).
 */

import { resolveAudioWorkletModuleUrl } from "./audio-worklet-module-urls";
import {
  constructBrowserAudioContext,
  constructBrowserAudioWorkletNode,
} from "./browser-audio-runtime";
import {
  floatPcmToInt16Bytes,
  VOICE_PCM_SAMPLE_RATE,
} from "./voice-session-pcm";

/** A device/permission error the caller must surface, not swallow. */
export class VoiceMicCaptureError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported"
      | "permission_denied"
      | "no_device"
      | "start_failed",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VoiceMicCaptureError";
  }
}

/** Minimal AudioContext surface the capture drives (real or injected fake). */
export interface MicAudioContextLike {
  readonly sampleRate: number;
  readonly state: AudioContextState;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createScriptProcessor?(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): ScriptProcessorNodeLike;
  audioWorklet?: { addModule(url: string): Promise<void> };
  destination: AudioNodeLike;
  resume(): Promise<void>;
  suspend?(): Promise<void>;
  close(): Promise<void>;
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

export interface ScriptProcessorNodeLike extends AudioNodeLike {
  onaudioprocess:
    | ((event: {
        inputBuffer: { getChannelData(channel: number): Float32Array };
      }) => void)
    | null;
}

export interface AudioWorkletNodeLike extends AudioNodeLike {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(data: unknown): void;
  };
}

function isAudioNodeLike(value: unknown): value is AudioNodeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "connect") === "function" &&
    typeof Reflect.get(value, "disconnect") === "function"
  );
}

function isAudioWorkletNodeLike(value: unknown): value is AudioWorkletNodeLike {
  if (!isAudioNodeLike(value)) return false;
  const port: unknown = Reflect.get(value, "port");
  return (
    typeof port === "object" &&
    port !== null &&
    "onmessage" in port &&
    typeof Reflect.get(port, "postMessage") === "function"
  );
}

function isMicAudioContextLike(value: unknown): value is MicAudioContextLike {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  return (
    typeof Reflect.get(value, "sampleRate") === "number" &&
    (state === "suspended" ||
      state === "interrupted" ||
      state === "running" ||
      state === "closed") &&
    isAudioNodeLike(Reflect.get(value, "destination")) &&
    typeof Reflect.get(value, "createMediaStreamSource") === "function" &&
    typeof Reflect.get(value, "resume") === "function" &&
    typeof Reflect.get(value, "close") === "function"
  );
}

type WorkletCapableMicContext = MicAudioContextLike & {
  audioWorklet: { addModule(url: string): Promise<void> };
};

export interface VoiceMicCaptureOptions {
  /** Emitted for every framed Int16 PCM chunk (little-endian, 16 kHz mono). */
  onFrame: (bytes: Uint8Array) => void;
  /** Called when capture pauses (page hidden / AudioContext suspended). */
  onSuspend?: () => void;
  /** Called when capture resumes after a suspend. */
  onResume?: () => void;
  /** Called on a fatal capture error mid-session. */
  onError?: (error: VoiceMicCaptureError) => void;
  /**
   * Target uplink frame duration (ms). The contract wants small frames
   * (~100-320ms); default 100ms = 1600 samples @16k = 3200 bytes.
   */
  frameMs?: number;
  /** Injectable getUserMedia (tests / non-standard hosts). */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injectable AudioContext factory (tests). */
  createAudioContext?: () => MicAudioContextLike;
  /**
   * Injectable visibility source. Defaults to the document. Tests drive it to
   * exercise the suspend/resume path without a real DOM.
   */
  visibility?: {
    addListener: (listener: () => void) => void;
    removeListener: (listener: () => void) => void;
    isHidden: () => boolean;
  };
}

const WORKLET_NAME = "eliza-voice-session-uplink";

/** Runtime AudioWorklet availability probe — never assumed (WebView 113). */
export function hasAudioWorkletSupport(
  ctx: MicAudioContextLike,
): ctx is WorkletCapableMicContext {
  return (
    typeof ctx.audioWorklet?.addModule === "function" &&
    typeof globalThis.AudioWorkletNode !== "undefined"
  );
}

/** Live capture handle. */
export interface VoiceMicCapture {
  /** Whether capture is currently emitting frames. */
  readonly active: boolean;
  /** Stop capture and release the mic + audio graph. Idempotent. */
  stop(): Promise<void>;
  /** Which backend is driving capture, for diagnostics/evidence. */
  readonly backend: "audioworklet" | "scriptprocessor";
}

/**
 * A streaming linear resampler (source rate → 16 kHz), carried across frames so
 * the fractional read position is continuous (no per-frame boundary glitch).
 */
class StreamingResampler {
  private position = 0;
  private tail = 0; // last sample of the previous block, for interpolation.
  private hasTail = false;
  private readonly ratio: number;

  constructor(private readonly sourceRate: number) {
    this.ratio = sourceRate / VOICE_PCM_SAMPLE_RATE;
  }

  push(block: Float32Array): Float32Array {
    if (this.sourceRate === VOICE_PCM_SAMPLE_RATE) return block;
    if (block.length === 0) return block;
    const out: number[] = [];
    // Virtual index space includes the carried tail at index -1.
    while (this.position < block.length) {
      const idx = this.position;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const s0 = i0 < 0 ? (this.hasTail ? this.tail : block[0]) : block[i0];
      const s1 =
        i0 + 1 < block.length ? block[i0 + 1] : block[block.length - 1];
      out.push(s0 + (s1 - s0) * frac);
      this.position += this.ratio;
    }
    // Carry: keep the last real sample; rebase position for the next block.
    this.tail = block[block.length - 1];
    this.hasTail = true;
    this.position -= block.length;
    return Float32Array.from(out);
  }
}

/**
 * Start mic capture. Resolves once the audio graph is live and emitting frames.
 * Throws {@link VoiceMicCaptureError} on unsupported host / permission denial.
 */
export async function startVoiceMicCapture(
  options: VoiceMicCaptureOptions,
): Promise<VoiceMicCapture> {
  const frameMs = options.frameMs ?? 100;
  const frameSamples = Math.round((VOICE_PCM_SAMPLE_RATE * frameMs) / 1000);

  const getUserMedia =
    options.getUserMedia ??
    ((constraints) => {
      if (
        typeof navigator === "undefined" ||
        typeof navigator.mediaDevices?.getUserMedia !== "function"
      ) {
        return Promise.reject(
          new VoiceMicCaptureError("getUserMedia unavailable", "unsupported"),
        );
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    });

  const createAudioContext =
    options.createAudioContext ??
    (() => {
      const context = constructBrowserAudioContext([], isMicAudioContextLike);
      if (!context) {
        throw new VoiceMicCaptureError(
          "AudioContext unavailable",
          "unsupported",
        );
      }
      return context;
    });

  let stream: MediaStream;
  try {
    stream = await getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new VoiceMicCaptureError(
        "microphone permission denied",
        "permission_denied",
        err,
      );
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new VoiceMicCaptureError("no microphone device", "no_device", err);
    }
    if (err instanceof VoiceMicCaptureError) throw err;
    throw new VoiceMicCaptureError("getUserMedia failed", "start_failed", err);
  }

  let acquiredContext: MicAudioContextLike | null = null;
  let acquiredSource: AudioNodeLike | null = null;
  try {
    acquiredContext = createAudioContext();
    if (
      acquiredContext.state === "suspended" ||
      acquiredContext.state === "interrupted"
    ) {
      try {
        await acquiredContext.resume();
      } catch (ignoredError) {
        void ignoredError;
        // best-effort; a running graph is confirmed by frame delivery.
      }
    }
    acquiredSource = acquiredContext.createMediaStreamSource(stream);
  } catch (error) {
    acquiredSource?.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await acquiredContext?.close().catch(() => {});
    if (error instanceof VoiceMicCaptureError) throw error;
    throw new VoiceMicCaptureError(
      "microphone audio pipeline failed to start",
      "start_failed",
      error,
    );
  }
  if (!acquiredContext || !acquiredSource) {
    for (const track of stream.getTracks()) track.stop();
    await acquiredContext?.close().catch(() => {});
    throw new VoiceMicCaptureError(
      "microphone audio pipeline failed to initialize",
      "start_failed",
    );
  }
  const ctx = acquiredContext;
  const source = acquiredSource;
  const resampler = new StreamingResampler(ctx.sampleRate);

  let stopped = false;
  let suspended = false;
  // Frame accumulator: collect resampled 16k samples, cut fixed-size frames.
  let pending = new Float32Array(0);

  const emitResampled = (mono: Float32Array): void => {
    if (stopped || suspended) return;
    const resampled = resampler.push(mono);
    if (resampled.length === 0) return;
    const merged = new Float32Array(pending.length + resampled.length);
    merged.set(pending);
    merged.set(resampled, pending.length);
    let offset = 0;
    while (merged.length - offset >= frameSamples) {
      const frame = merged.subarray(offset, offset + frameSamples);
      options.onFrame(floatPcmToInt16Bytes(frame));
      offset += frameSamples;
    }
    pending = merged.slice(offset);
  };

  let backend: "audioworklet" | "scriptprocessor";
  let workletNode: AudioWorkletNodeLike | null = null;
  let scriptNode: ScriptProcessorNodeLike | null = null;

  try {
    if (hasAudioWorkletSupport(ctx)) {
      backend = "audioworklet";
      await ctx.audioWorklet.addModule(resolveAudioWorkletModuleUrl("uplink"));
      const node = constructBrowserAudioWorkletNode(
        ctx,
        WORKLET_NAME,
        isAudioWorkletNodeLike,
      );
      if (!node) {
        throw new VoiceMicCaptureError(
          "AudioWorkletNode unavailable",
          "unsupported",
        );
      }
      workletNode = node;
      node.port.onmessage = (event) => {
        const data = event.data as { pcm?: Float32Array } | undefined;
        if (data?.pcm) emitResampled(data.pcm);
      };
      source.connect(node);
      // Worklet needs a graph terminus to pull frames; connect to destination.
      node.connect(ctx.destination);
    } else if (typeof ctx.createScriptProcessor === "function") {
      backend = "scriptprocessor";
      // 4096-sample buffer is the WebView-113-safe choice (power of two, low
      // dropout risk). Mono in, mono out.
      scriptNode = ctx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        // Copy: the underlying buffer is reused by the engine after this callback.
        emitResampled(channel.slice());
      };
      source.connect(scriptNode);
      scriptNode.connect(ctx.destination);
    } else {
      throw new VoiceMicCaptureError(
        "no AudioWorklet or ScriptProcessor available",
        "unsupported",
      );
    }
  } catch (error) {
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await ctx.close().catch(() => {});
    if (error instanceof VoiceMicCaptureError) throw error;
    throw new VoiceMicCaptureError(
      "microphone audio pipeline failed to start",
      "start_failed",
      error,
    );
  }

  // Visibility / suspend handling (iOS PWA).
  const visibility =
    options.visibility ??
    (typeof document !== "undefined"
      ? {
          addListener: (l: () => void) =>
            document.addEventListener("visibilitychange", l),
          removeListener: (l: () => void) =>
            document.removeEventListener("visibilitychange", l),
          isHidden: () => document.visibilityState === "hidden",
        }
      : null);

  const onVisibilityChange = (): void => {
    if (stopped || !visibility) return;
    if (visibility.isHidden()) {
      if (!suspended) {
        suspended = true;
        void ctx.suspend?.().catch(() => {});
        options.onSuspend?.();
      }
    } else if (suspended) {
      suspended = false;
      void ctx.resume().catch(() => {});
      options.onResume?.();
    }
  };
  visibility?.addListener(onVisibilityChange);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    visibility?.removeListener(onVisibilityChange);
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await ctx.close().catch(() => {});
  };

  return {
    get active() {
      return !stopped && !suspended;
    },
    get backend() {
      return backend;
    },
    stop,
  };
}
