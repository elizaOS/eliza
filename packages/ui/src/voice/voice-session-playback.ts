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
  /** Notified when the queue drains to empty (utterance finished playing). */
  onDrained?: () => void;
}

const PLAYBACK_WORKLET_NAME = "eliza-voice-session-downlink";

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
  /** Push a pcm16 downlink frame for streaming playback. */
  enqueue(bytes: Uint8Array): void;
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

  let stopped = false;
  let needsUnlock = false;
  // Pre-unlock queue (frames enqueued while suspended); flushed into the sink
  // once running so no audio is dropped, only deferred.
  const preUnlockQueue: Float32Array[] = [];

  let backend: "audioworklet" | "scriptprocessor";
  let workletNode: PlaybackWorkletNodeLike | null = null;
  let scriptNode: PlaybackScriptNodeLike | null = null;

  // ScriptProcessor-side JS queue (used only for the fallback backend).
  const jsQueue: Float32Array[] = [];
  let jsReadOffset = 0;
  let jsHadAudio = false;

  try {
    if (hasPlaybackWorkletSupport(ctx)) {
      backend = "audioworklet";
      await ctx.audioWorklet.addModule(
        resolveAudioWorkletModuleUrl("downlink"),
      );
      const node = constructBrowserAudioWorkletNode(
        ctx,
        PLAYBACK_WORKLET_NAME,
        isPlaybackWorkletNodeLike,
      );
      if (!node) {
        throw new Error("AudioWorkletNode unavailable for playback");
      }
      workletNode = node;
      node.port.onmessage = (event) => {
        const d = event.data as { type?: string } | undefined;
        if (d?.type === "drained") options.onDrained?.();
      };
      node.connect(ctx.destination);
    } else if (typeof ctx.createScriptProcessor === "function") {
      backend = "scriptprocessor";
      scriptNode = ctx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (event) => {
        const outBuf = event.outputBuffer;
        const ch = outBuf.getChannelData(0);
        for (let i = 0; i < ch.length; i += 1) {
          while (jsQueue.length > 0 && jsReadOffset >= jsQueue[0].length) {
            jsQueue.shift();
            jsReadOffset = 0;
          }
          if (jsQueue.length === 0) {
            ch[i] = 0;
            if (jsHadAudio) {
              jsHadAudio = false;
              options.onDrained?.();
            }
          } else {
            ch[i] = jsQueue[0][jsReadOffset];
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

  const pushSamples = (samples: Float32Array): void => {
    if (backend === "audioworklet" && workletNode) {
      workletNode.port.postMessage({ type: "pcm", pcm: samples }, [
        samples.buffer,
      ]);
    } else {
      jsQueue.push(samples);
      jsHadAudio = true;
    }
  };

  const drainPreUnlock = (): void => {
    while (preUnlockQueue.length > 0) {
      const s = preUnlockQueue.shift();
      if (s) pushSamples(s);
    }
  };

  const isRunning = (): boolean => ctx.state === "running";

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
    enqueue(bytes: Uint8Array) {
      if (stopped) return;
      const samples = int16BytesToFloatPcm(bytes);
      if (samples.length === 0) return;
      if (!isRunning()) {
        // Buffer until unlocked; do not drop.
        needsUnlock = true;
        preUnlockQueue.push(samples);
        return;
      }
      pushSamples(samples);
    },
    flush() {
      // Immediate silence for barge-in — clear BOTH the deferred and live queues.
      preUnlockQueue.length = 0;
      if (backend === "audioworklet" && workletNode) {
        workletNode.port.postMessage({ type: "flush" });
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
        needsUnlock = false;
        drainPreUnlock();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
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
      await ctx.close().catch(() => {});
    },
  };
}
