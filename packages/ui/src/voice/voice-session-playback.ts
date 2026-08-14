/**
 * Streaming PCM downlink playback sink for the realtime voice-session client.
 *
 * Downlink frames are pcm16 (Int16 LE, 16 kHz mono) from Cartesia. They must
 * play AS THEY ARRIVE — no `decodeAudioData` full-clip barrier (that was a named
 * latency bug in VOICE-REGRESSION-ROOTCAUSE.md; buffering the whole utterance
 * before first audio adds seconds of dead air).
 *
 * Implementation:
 *   - AudioWorklet ring buffer when available (WebView 113 has it, but a
 *     hardened embedded WebView may not — VERIFIED at runtime, never assumed).
 *   - ScriptProcessor fallback pulls from the same JS-side queue.
 *   - `enqueue(bytes)` pushes a downlink frame; playback pulls at the context
 *     rate. `flush()` empties the queue immediately for barge-in (do NOT wait
 *     for the server `interrupted` event to stop audible output).
 *   - `pause()` stops consuming queued audio for provisional acoustic barge-in;
 *     `resume()` continues from the same sample if the server does not confirm.
 *   - iOS autoplay: the AudioContext starts suspended until a user gesture calls
 *     `unlock()`. `enqueue` before unlock buffers; nothing is dropped, but a
 *     caller should surface "tap to enable sound" via `needsUnlock`.
 *
 * Tests inject a fake AudioContext to drive the real queue/flush/unlock code.
 */

import { resolveAudioWorkletModuleUrl } from "./audio-worklet-module-urls";
import {
  constructBrowserAudioContext,
  constructBrowserAudioWorkletNode,
} from "./browser-audio-runtime";
import { StreamingLinearResampler } from "./streaming-linear-resampler";
import type { VoicePlaybackDiagnostics } from "./voice-session-media-diagnostics";
import {
  int16BytesToFloatPcm,
  VOICE_PCM_SAMPLE_RATE,
} from "./voice-session-pcm";

export interface PlaybackAudioContextLike {
  readonly sampleRate: number;
  readonly state: AudioContextState;
  audioWorklet?: { addModule(url: string): Promise<void> };
  createScriptProcessor?(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): PlaybackScriptNodeLike;
  destination: PlaybackNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface PlaybackNodeLike {
  connect(target: PlaybackNodeLike): PlaybackNodeLike;
  disconnect(): void;
}

export interface PlaybackScriptNodeLike extends PlaybackNodeLike {
  onaudioprocess:
    | ((event: {
        outputBuffer: {
          numberOfChannels: number;
          getChannelData(channel: number): Float32Array;
        };
      }) => void)
    | null;
}

export interface PlaybackWorkletNodeLike extends PlaybackNodeLike {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(data: unknown, transfer?: Transferable[]): void;
  };
}

function isPlaybackNodeLike(value: unknown): value is PlaybackNodeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "connect") === "function" &&
    typeof Reflect.get(value, "disconnect") === "function"
  );
}

function isPlaybackWorkletNodeLike(
  value: unknown,
): value is PlaybackWorkletNodeLike {
  if (!isPlaybackNodeLike(value)) return false;
  const port: unknown = Reflect.get(value, "port");
  return (
    typeof port === "object" &&
    port !== null &&
    "onmessage" in port &&
    typeof Reflect.get(port, "postMessage") === "function"
  );
}

function isPlaybackAudioContextLike(
  value: unknown,
): value is PlaybackAudioContextLike {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  return (
    typeof Reflect.get(value, "sampleRate") === "number" &&
    (state === "suspended" ||
      state === "interrupted" ||
      state === "running" ||
      state === "closed") &&
    isPlaybackNodeLike(Reflect.get(value, "destination")) &&
    typeof Reflect.get(value, "resume") === "function" &&
    typeof Reflect.get(value, "close") === "function"
  );
}

type WorkletCapablePlaybackContext = PlaybackAudioContextLike & {
  audioWorklet: { addModule(url: string): Promise<void> };
};

export interface VoiceSessionPlaybackOptions {
  createAudioContext?: () => PlaybackAudioContextLike;
  /** Cancels provisional setup and closes any live playback graph. */
  signal?: AbortSignal;
  /**
   * Attempt `AudioContext.resume()` immediately after constructing the context.
   * The resume call itself therefore runs before this async factory yields,
   * preserving the browser user activation held by the caller of `start()`.
   */
  unlockOnCreate?: boolean;
  /** Notified when queued audio starts/stops waiting for an unlock gesture. */
  onUnlockChange?: (needsUnlock: boolean) => void;
  /** Content-free requested/actual playback settings for device evaluation. */
  onDiagnostics?: (diagnostics: VoicePlaybackDiagnostics) => void;
  /** Notified when the engine first consumes a sequenced audio frame. */
  onStarted?: (sequence: number) => void;
  /** Notified with the exact newest enqueue sequence that drained. */
  onDrained?: (sequence: number) => void;
}

const PLAYBACK_WORKLET_NAME = "eliza-voice-session-downlink";

class VoicePlaybackSetupCancelledError extends Error {
  constructor(cause?: unknown) {
    super("voice playback setup cancelled", { cause });
    this.name = "AbortError";
  }
}

function throwIfPlaybackCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new VoicePlaybackSetupCancelledError(signal.reason);
  }
}

function awaitPlaybackSetup<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new VoicePlaybackSetupCancelledError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new VoicePlaybackSetupCancelledError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function hasPlaybackWorkletSupport(
  ctx: PlaybackAudioContextLike,
): ctx is WorkletCapablePlaybackContext {
  return (
    typeof ctx.audioWorklet?.addModule === "function" &&
    typeof globalThis.AudioWorkletNode !== "undefined"
  );
}

export interface VoiceSessionPlayback {
  /** Whether the AudioContext is unlocked (running) and can emit sound. */
  readonly unlocked: boolean;
  /** True if audio has been enqueued while still suspended (surface a prompt). */
  readonly needsUnlock: boolean;
  /** Whether playout is provisionally silent without consuming queued audio. */
  readonly paused: boolean;
  readonly backend: "audioworklet" | "scriptprocessor";
  /** Push a pcm16 frame and return its monotonic playout sequence. */
  enqueue(bytes: Uint8Array): number | null;
  /** Provisionally silence playback while retaining the queue. Idempotent. */
  pause(): void;
  /** Continue retained playback after an unconfirmed local speech trigger. */
  resume(): void;
  /** Empty the playback queue IMMEDIATELY (barge-in). */
  flush(): void;
  /** Resume the AudioContext on a user gesture (iOS autoplay unlock). */
  unlock(): Promise<void>;
  /** Tear down the graph + close the context. Idempotent. */
  stop(): Promise<void>;
}

export async function createVoiceSessionPlayback(
  options: VoiceSessionPlaybackOptions = {},
): Promise<VoiceSessionPlayback> {
  const signal = options.signal;
  throwIfPlaybackCancelled(signal);
  const createAudioContext =
    options.createAudioContext ??
    (() => {
      const context = constructBrowserAudioContext(
        [{ sampleRate: VOICE_PCM_SAMPLE_RATE }],
        isPlaybackAudioContextLike,
      );
      if (!context) throw new Error("AudioContext unavailable for playback");
      // Request a native 16 kHz context. Browsers that force a device-native
      // rate (commonly 44.1/48 kHz) are corrected by the streaming resampler.
      return context;
    });

  const ctx = createAudioContext();
  if (signal?.aborted) {
    await ctx.close().catch(() => {});
    throw new VoicePlaybackSetupCancelledError(signal.reason);
  }
  // `resume()` must be INVOKED while the start gesture is still active. Do not
  // move this below the AudioWorklet module await: by then Safari/iOS may have
  // consumed the transient user activation. A rejected autoplay attempt is
  // expected for non-gesture starts and is surfaced later via `needsUnlock`.
  const initialUnlock =
    options.unlockOnCreate &&
    (ctx.state === "suspended" || ctx.state === "interrupted")
      ? ctx.resume().catch(() => {})
      : null;

  let stopped = false;
  let paused = false;
  let needsUnlock = false;
  const resampler = new StreamingLinearResampler(
    VOICE_PCM_SAMPLE_RATE,
    ctx.sampleRate,
  );
  const setNeedsUnlock = (next: boolean): void => {
    if (needsUnlock === next) return;
    needsUnlock = next;
    try {
      options.onUnlockChange?.(next);
    } catch (ignoredError) {
      // UI notification is best-effort; playback must remain independent.
      void ignoredError;
    }
  };
  // Pre-unlock queue (frames enqueued while suspended); flushed into the sink
  // once running so no audio is dropped, only deferred.
  interface QueuedPlaybackFrame {
    samples: Float32Array;
    sequence: number;
    started: boolean;
  }
  const preUnlockQueue: QueuedPlaybackFrame[] = [];

  // AudioWorklet messages cross an asynchronous port in each direction. A
  // `drained` notification for an old queue can therefore arrive after the
  // main thread has enqueued newer audio. Sequence every queue mutation so a
  // stale notification can never clear the newer response's activity state.
  let activitySequence = 0;
  let latestActivitySequence = 0;
  let lastFlushSequence = 0;
  let lastStartedSequence = 0;
  const nextActivitySequence = (): number => {
    activitySequence += 1;
    latestActivitySequence = activitySequence;
    return activitySequence;
  };
  const emitStarted = (sequence: number): void => {
    try {
      options.onStarted?.(sequence);
    } catch (ignoredError) {
      // error-policy:J7 playout diagnostics must never break audio delivery.
      void ignoredError;
    }
  };
  const emitDrained = (sequence: number): void => {
    try {
      options.onDrained?.(sequence);
    } catch (ignoredError) {
      // error-policy:J7 playout diagnostics must never break audio delivery.
      void ignoredError;
    }
  };

  let backend: "audioworklet" | "scriptprocessor";
  let workletNode: PlaybackWorkletNodeLike | null = null;
  let scriptNode: PlaybackScriptNodeLike | null = null;

  // ScriptProcessor-side JS queue (used only for the fallback backend).
  const jsQueue: QueuedPlaybackFrame[] = [];
  let jsReadOffset = 0;
  let jsHadAudio = false;
  let jsLatestSequence = 0;

  try {
    if (hasPlaybackWorkletSupport(ctx)) {
      backend = "audioworklet";
      await awaitPlaybackSetup(
        ctx.audioWorklet.addModule(resolveAudioWorkletModuleUrl("downlink")),
        signal,
      );
      throwIfPlaybackCancelled(signal);
      const node = constructBrowserAudioWorkletNode(
        ctx,
        PLAYBACK_WORKLET_NAME,
        isPlaybackWorkletNodeLike,
      );
      if (!node) {
        throw new Error("AudioWorkletNode unavailable for playback");
      }
      workletNode = node;
      throwIfPlaybackCancelled(signal);
      node.port.onmessage = (event) => {
        const d = event.data as
          | { type?: string; sequence?: unknown }
          | undefined;
        if (
          d?.type === "started" &&
          typeof d.sequence === "number" &&
          Number.isSafeInteger(d.sequence) &&
          d.sequence > lastFlushSequence &&
          d.sequence > lastStartedSequence &&
          d.sequence <= latestActivitySequence
        ) {
          lastStartedSequence = d.sequence;
          emitStarted(d.sequence);
          return;
        }
        if (
          d?.type === "drained" &&
          typeof d.sequence === "number" &&
          Number.isSafeInteger(d.sequence) &&
          d.sequence > lastFlushSequence &&
          d.sequence === latestActivitySequence
        ) {
          emitDrained(d.sequence);
        }
      };
      node.connect(ctx.destination);
    } else if (typeof ctx.createScriptProcessor === "function") {
      backend = "scriptprocessor";
      throwIfPlaybackCancelled(signal);
      scriptNode = ctx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (event) => {
        const outBuf = event.outputBuffer;
        const ch = outBuf.getChannelData(0);
        if (paused) {
          ch.fill(0);
          for (let c = 1; c < outBuf.numberOfChannels; c += 1) {
            outBuf.getChannelData(c).fill(0);
          }
          return;
        }
        for (let i = 0; i < ch.length; i += 1) {
          while (
            jsQueue.length > 0 &&
            jsReadOffset >= jsQueue[0].samples.length
          ) {
            jsQueue.shift();
            jsReadOffset = 0;
          }
          if (jsQueue.length === 0) {
            ch[i] = 0;
            if (jsHadAudio) {
              jsHadAudio = false;
              emitDrained(jsLatestSequence);
            }
          } else {
            const frame = jsQueue[0];
            if (!frame.started) {
              frame.started = true;
              lastStartedSequence = frame.sequence;
              emitStarted(frame.sequence);
            }
            ch[i] = frame.samples[jsReadOffset];
            jsReadOffset += 1;
          }
        }
        for (let c = 1; c < outBuf.numberOfChannels; c += 1) {
          outBuf.getChannelData(c).set(ch);
        }
      };
      scriptNode.connect(ctx.destination);
    } else {
      throw new Error("no AudioWorklet or ScriptProcessor for playback");
    }
  } catch (error) {
    stopped = true;
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    await ctx.close().catch(() => {});
    throw error;
  }

  try {
    options.onDiagnostics?.({
      backend,
      requestedSampleRateHz: VOICE_PCM_SAMPLE_RATE,
      actualSampleRateHz: ctx.sampleRate,
      sampleRateConversion:
        ctx.sampleRate === VOICE_PCM_SAMPLE_RATE
          ? "not_required"
          : "streaming_linear",
    });
  } catch (ignoredError) {
    // error-policy:J7 diagnostic listeners must never break an active playback graph.
    void ignoredError;
  }

  let onAbort: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    paused = false;
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    preUnlockQueue.length = 0;
    jsQueue.length = 0;
    resampler.reset();
    setNeedsUnlock(false);
    stopPromise = ctx.close().catch(() => {});
    return stopPromise;
  };

  onAbort = () => {
    void stop();
  };
  if (signal?.aborted) {
    await stop();
    throw new VoicePlaybackSetupCancelledError(signal.reason);
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  const pushSamples = (frame: QueuedPlaybackFrame): void => {
    if (backend === "audioworklet" && workletNode) {
      workletNode.port.postMessage(
        { type: "pcm", pcm: frame.samples, sequence: frame.sequence },
        [frame.samples.buffer],
      );
    } else {
      jsQueue.push(frame);
      jsHadAudio = true;
      jsLatestSequence = frame.sequence;
    }
  };

  const drainPreUnlock = (): void => {
    while (preUnlockQueue.length > 0) {
      const frame = preUnlockQueue.shift();
      if (frame) pushSamples(frame);
    }
  };

  const isRunning = (): boolean => ctx.state === "running";

  // Do not await a browser-blocked resume promise: some engines keep it pending
  // until a later gesture, which must not stall mint/connection. If it resolves
  // after audio was queued, drain that queue and clear the CTA state.
  if (initialUnlock) {
    void initialUnlock.then(() => {
      if (stopped || !isRunning()) return;
      setNeedsUnlock(false);
      drainPreUnlock();
    });
  }

  return {
    get unlocked() {
      return isRunning();
    },
    get needsUnlock() {
      return needsUnlock;
    },
    get paused() {
      return paused;
    },
    get backend() {
      return backend;
    },
    enqueue(bytes: Uint8Array) {
      if (stopped) return null;
      const samples = resampler.push(int16BytesToFloatPcm(bytes));
      if (samples.length === 0) return null;
      const frame = {
        samples,
        sequence: nextActivitySequence(),
        started: false,
      };
      if (!isRunning()) {
        // Buffer until unlocked; do not drop.
        setNeedsUnlock(true);
        preUnlockQueue.push(frame);
        return frame.sequence;
      }
      pushSamples(frame);
      return frame.sequence;
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({ type: "pause" });
      }
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({ type: "resume" });
      }
    },
    flush() {
      // Immediate silence for barge-in — clear BOTH the deferred and live queues.
      paused = false;
      const flushSequence = nextActivitySequence();
      lastFlushSequence = flushSequence;
      resampler.reset();
      preUnlockQueue.length = 0;
      // A flush discards every frame that was waiting for a gesture, so the UI
      // must not keep advertising an unlock for audio that no longer exists.
      setNeedsUnlock(false);
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({
          type: "flush",
          sequence: flushSequence,
        });
      } else {
        jsQueue.length = 0;
        jsReadOffset = 0;
        jsHadAudio = false;
      }
    },
    async unlock() {
      if (stopped) return;
      if (ctx.state === "suspended" || ctx.state === "interrupted") {
        await ctx.resume().catch(() => {});
      }
      if (isRunning()) {
        setNeedsUnlock(false);
        drainPreUnlock();
      }
    },
    stop,
  };
}
