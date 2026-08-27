/**
 * Streaming PCM downlink playback sink for the realtime voice-session client.
 *
 * Downlink frames are pcm16 (Int16 LE, 16 kHz mono) from Cartesia. Playback
 * holds only a bounded startup/recovery reserve, then streams continuously; a
 * full-clip barrier would add seconds of dead air, while zero reserve exposes
 * provider/network chunk jitter as audible pauses.
 *
 * Implementation:
 *   - AudioWorklet ring buffer when available (WebView 113 has it, but a
 *     hardened embedded WebView may not — VERIFIED at runtime, never assumed).
 *   - ScriptProcessor fallback pulls from the same JS-side queue.
 *   - `beginInput()` / `finishInput()` bound each server utterance so a short
 *     final clip never waits forever for the reserve. `flush()` empties every
 *     queue immediately for barge-in.
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
  /** Notified when the queue drains to empty (utterance finished playing). */
  onDrained?: () => void;
  /** Notified after a requested old-to-new response crossfade completes. */
  onHandoffComplete?: () => void;
  /**
   * Initial/recovery playout reserve. Frames are released once this much PCM
   * is queued, or immediately when the server marks a short utterance final.
   */
  preRollMs?: number;
  /** Monotonic clock for sanitized arrival-gap instrumentation. */
  now?: () => number;
  /** Queue/timing counters only; never audio bytes or transcript text. */
  onStats?: (event: VoiceSessionPlaybackStatsEvent) => void;
}

const PLAYBACK_WORKLET_NAME = "eliza-voice-session-downlink";
export const DEFAULT_VOICE_PLAYBACK_PRE_ROLL_MS = 120;

export type VoiceSessionPlaybackStatsReason =
  | "started"
  | "underrun"
  | "finished"
  | "flushed"
  | "stopped";

export interface VoiceSessionPlaybackStats {
  readonly backend: "audioworklet" | "scriptprocessor";
  readonly preRollMs: number;
  readonly framesEnqueued: number;
  readonly samplesEnqueued: number;
  readonly queuedSamples: number;
  readonly maxQueuedSamples: number;
  readonly underrunCount: number;
  readonly maxInterFrameGapMs: number;
  readonly maxPreRollWaitMs: number;
}

export interface VoiceSessionPlaybackStatsEvent {
  readonly reason: VoiceSessionPlaybackStatsReason;
  readonly stats: VoiceSessionPlaybackStats;
}

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
  readonly backend: "audioworklet" | "scriptprocessor";
  /** Start a new server-authored utterance and arm its jitter reserve. */
  beginInput(): void;
  /** Push a pcm16 downlink frame for streaming playback. */
  enqueue(bytes: Uint8Array): void;
  /** Release a short final utterance even when it never filled the reserve. */
  finishInput(): void;
  /** Preserve queued old audio until new audio arrives, then crossfade. */
  beginHandoff(crossfadeMs: number): void;
  /** Empty the playback queue IMMEDIATELY (barge-in). */
  flush(): void;
  /** Sanitized queue/timing counters; never audio or transcript content. */
  getStats(): VoiceSessionPlaybackStats;
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
      // Request a 16 kHz context so the pcm16 downlink plays at native rate with
      // no resample; if the platform ignores it (Safari sometimes forces 44.1),
      // the ScriptProcessor/worklet plays the raw samples — a pitch shift the
      // caller can correct later, but correctness of framing/flush is unaffected.
      return context;
    });

  const ctx = createAudioContext();
  const now = options.now ?? (() => performance.now());
  const preRollMs = Math.max(
    0,
    options.preRollMs ?? DEFAULT_VOICE_PLAYBACK_PRE_ROLL_MS,
  );
  const preRollSamples = Math.round((ctx.sampleRate * preRollMs) / 1_000);
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
  let needsUnlock = false;
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
  const preUnlockQueue: Float32Array[] = [];

  let backend: "audioworklet" | "scriptprocessor" = "scriptprocessor";
  let workletNode: PlaybackWorkletNodeLike | null = null;
  let scriptNode: PlaybackScriptNodeLike | null = null;

  // ScriptProcessor-side JS queue (used only for the fallback backend).
  const jsQueue: Float32Array[] = [];
  let jsReadOffset = 0;
  let jsHadAudio = false;
  let jsHandoffQueue: Float32Array[] = [];
  let jsHandoffReadOffset = 0;
  let jsCrossfadeSamples = 0;
  let jsCrossfadePosition = 0;

  const startQueue: Float32Array[] = [];
  let startQueueSamples = 0;
  let preUnlockSamples = 0;
  let sinkQueuedSamples = 0;
  let inputFinished = true;
  let playbackStarted = false;
  let firstQueuedAtMs: number | null = null;
  let lastFrameAtMs: number | null = null;
  let framesEnqueued = 0;
  let samplesEnqueued = 0;
  let maxQueuedSamples = 0;
  let underrunCount = 0;
  let maxInterFrameGapMs = 0;
  let maxPreRollWaitMs = 0;
  let lastSubmittedSequence = 0;

  const currentQueuedSamples = (): number =>
    startQueueSamples + preUnlockSamples + sinkQueuedSamples;

  const updateMaxQueuedSamples = (): void => {
    maxQueuedSamples = Math.max(maxQueuedSamples, currentQueuedSamples());
  };

  const snapshotStats = (): VoiceSessionPlaybackStats => ({
    backend,
    preRollMs,
    framesEnqueued,
    samplesEnqueued,
    queuedSamples: currentQueuedSamples(),
    maxQueuedSamples,
    underrunCount,
    maxInterFrameGapMs,
    maxPreRollWaitMs,
  });

  const emitStats = (reason: VoiceSessionPlaybackStatsReason): void => {
    try {
      options.onStats?.({ reason, stats: snapshotStats() });
    } catch (ignoredError) {
      // error-policy:J7 Diagnostics must never interrupt audible playback.
      void ignoredError;
    }
  };

  const handleSinkDrained = (): void => {
    sinkQueuedSamples = 0;
    playbackStarted = false;
    if (!inputFinished) {
      underrunCount += 1;
      firstQueuedAtMs = null;
      emitStats("underrun");
    } else {
      emitStats("finished");
      options.onDrained?.();
    }
  };

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
          | { type?: string; queuedSamples?: number; sequence?: number }
          | undefined;
        if (
          Number.isFinite(d?.sequence) &&
          Number(d?.sequence) < lastSubmittedSequence
        ) {
          return;
        }
        if (d?.type === "queue-depth" && Number.isFinite(d.queuedSamples)) {
          sinkQueuedSamples = Math.max(0, Number(d.queuedSamples));
          updateMaxQueuedSamples();
        } else if (d?.type === "drained") {
          handleSinkDrained();
        } else if (d?.type === "handoff-completed") {
          options.onHandoffComplete?.();
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
        let consumedSamples = 0;
        let handoffCompleted = false;
        for (let i = 0; i < ch.length; i += 1) {
          while (jsQueue.length > 0 && jsReadOffset >= jsQueue[0].length) {
            jsQueue.shift();
            jsReadOffset = 0;
          }
          while (
            jsHandoffQueue.length > 0 &&
            jsHandoffReadOffset >= jsHandoffQueue[0].length
          ) {
            jsHandoffQueue.shift();
            jsHandoffReadOffset = 0;
          }
          const nextSample =
            jsQueue.length > 0 ? jsQueue[0][jsReadOffset] : null;
          const oldSample =
            jsHandoffQueue.length > 0
              ? jsHandoffQueue[0][jsHandoffReadOffset]
              : null;
          if (
            nextSample !== null &&
            oldSample !== null &&
            jsCrossfadeSamples > 0
          ) {
            const progress = Math.min(
              1,
              jsCrossfadePosition / jsCrossfadeSamples,
            );
            ch[i] = oldSample * (1 - progress) + nextSample * progress;
            jsReadOffset += 1;
            jsHandoffReadOffset += 1;
            jsCrossfadePosition += 1;
            consumedSamples += 1;
            if (jsCrossfadePosition >= jsCrossfadeSamples) {
              jsHandoffQueue = [];
              jsHandoffReadOffset = 0;
              handoffCompleted = true;
            }
          } else if (nextSample !== null) {
            ch[i] = nextSample;
            jsReadOffset += 1;
            consumedSamples += 1;
          } else if (oldSample !== null) {
            ch[i] = oldSample;
            jsHandoffReadOffset += 1;
          } else {
            ch[i] = 0;
          }
        }
        sinkQueuedSamples = Math.max(0, sinkQueuedSamples - consumedSamples);
        for (let c = 1; c < outBuf.numberOfChannels; c += 1) {
          outBuf.getChannelData(c).set(ch);
        }
        if (handoffCompleted) options.onHandoffComplete?.();
        if (jsQueue.length === 0 && jsHandoffQueue.length === 0 && jsHadAudio) {
          jsHadAudio = false;
          handleSinkDrained();
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

  let onAbort: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
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
    preUnlockSamples = 0;
    startQueue.length = 0;
    startQueueSamples = 0;
    jsQueue.length = 0;
    jsHandoffQueue = [];
    sinkQueuedSamples = 0;
    setNeedsUnlock(false);
    emitStats("stopped");
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

  const pushSamples = (samples: Float32Array): void => {
    const sampleCount = samples.length;
    if (backend === "audioworklet" && workletNode) {
      const sequence = ++lastSubmittedSequence;
      workletNode.port.postMessage({ type: "pcm", pcm: samples, sequence }, [
        samples.buffer,
      ]);
    } else {
      jsQueue.push(samples);
      jsHadAudio = true;
    }
    sinkQueuedSamples += sampleCount;
    updateMaxQueuedSamples();
  };

  const deliverSamples = (samples: Float32Array): void => {
    if (!isRunning()) {
      setNeedsUnlock(true);
      preUnlockQueue.push(samples);
      preUnlockSamples += samples.length;
      updateMaxQueuedSamples();
      return;
    }
    pushSamples(samples);
  };

  const releaseStartQueue = (): void => {
    if (startQueue.length === 0) return;
    if (!inputFinished && startQueueSamples < preRollSamples) return;
    if (firstQueuedAtMs !== null) {
      maxPreRollWaitMs = Math.max(maxPreRollWaitMs, now() - firstQueuedAtMs);
    }
    playbackStarted = true;
    emitStats("started");
    while (startQueue.length > 0) {
      const samples = startQueue.shift();
      if (!samples) continue;
      startQueueSamples -= samples.length;
      deliverSamples(samples);
    }
    startQueueSamples = 0;
  };

  const drainPreUnlock = (): void => {
    while (preUnlockQueue.length > 0) {
      const s = preUnlockQueue.shift();
      if (!s) continue;
      preUnlockSamples -= s.length;
      pushSamples(s);
    }
    preUnlockSamples = 0;
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
    get backend() {
      return backend;
    },
    beginInput() {
      if (stopped) return;
      inputFinished = false;
      firstQueuedAtMs = null;
      lastFrameAtMs = null;
    },
    enqueue(bytes: Uint8Array) {
      if (stopped) return;
      const samples = int16BytesToFloatPcm(bytes);
      if (samples.length === 0) return;
      const receivedAtMs = now();
      if (lastFrameAtMs !== null) {
        maxInterFrameGapMs = Math.max(
          maxInterFrameGapMs,
          receivedAtMs - lastFrameAtMs,
        );
      }
      lastFrameAtMs = receivedAtMs;
      firstQueuedAtMs ??= receivedAtMs;
      framesEnqueued += 1;
      samplesEnqueued += samples.length;

      if (playbackStarted) {
        deliverSamples(samples);
        return;
      }
      startQueue.push(samples);
      startQueueSamples += samples.length;
      updateMaxQueuedSamples();
      releaseStartQueue();
    },
    finishInput() {
      if (stopped) return;
      inputFinished = true;
      if (
        startQueue.length === 0 &&
        preUnlockQueue.length === 0 &&
        sinkQueuedSamples === 0 &&
        !playbackStarted
      ) {
        emitStats("finished");
        options.onDrained?.();
        return;
      }
      releaseStartQueue();
    },
    beginHandoff(crossfadeMs: number) {
      if (stopped) return;
      const boundedMs = Math.min(250, Math.max(20, crossfadeMs));
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({
          type: "handoff",
          crossfadeSamples: Math.round((ctx.sampleRate * boundedMs) / 1_000),
          sequence: ++lastSubmittedSequence,
        });
      } else {
        jsHandoffQueue = jsQueue.splice(0);
        jsHandoffReadOffset = jsReadOffset;
        jsReadOffset = 0;
        jsCrossfadeSamples = Math.round((ctx.sampleRate * boundedMs) / 1_000);
        jsCrossfadePosition = 0;
      }
      inputFinished = false;
      playbackStarted = true;
      firstQueuedAtMs = null;
      lastFrameAtMs = null;
    },
    getStats() {
      return snapshotStats();
    },
    flush() {
      // Immediate silence for barge-in — clear BOTH the deferred and live queues.
      preUnlockQueue.length = 0;
      preUnlockSamples = 0;
      startQueue.length = 0;
      startQueueSamples = 0;
      sinkQueuedSamples = 0;
      playbackStarted = false;
      inputFinished = true;
      firstQueuedAtMs = null;
      lastFrameAtMs = null;
      // A flush discards every frame that was waiting for a gesture, so the UI
      // must not keep advertising an unlock for audio that no longer exists.
      setNeedsUnlock(false);
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({
          type: "flush",
          sequence: ++lastSubmittedSequence,
        });
      } else {
        jsQueue.length = 0;
        jsHandoffQueue = [];
        jsReadOffset = 0;
        jsHadAudio = false;
      }
      emitStats("flushed");
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
