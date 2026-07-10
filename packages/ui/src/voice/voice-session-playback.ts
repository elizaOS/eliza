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

import {
  int16BytesToFloatPcm,
  VOICE_PCM_SAMPLE_RATE,
} from "./voice-session-pcm";

export interface PlaybackAudioContextLike {
  readonly sampleRate: number;
  readonly state: "suspended" | "running" | "closed";
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

export interface VoiceSessionPlaybackOptions {
  createAudioContext?: () => PlaybackAudioContextLike;
  /** Notified when the queue drains to empty (utterance finished playing). */
  onDrained?: () => void;
}

const PLAYBACK_WORKLET_NAME = "eliza-voice-session-downlink";

// The worklet owns a growable ring of Float32 samples; the main thread posts
// PCM frames + a "flush" command. It pulls samples per render quantum, emitting
// silence when starved (so playback never blocks) and posting "drained" when it
// transitions from having audio to empty.
const PLAYBACK_WORKLET_SOURCE = `
class ElizaVoiceSessionDownlink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.hadAudio = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'pcm' && d.pcm) { this.queue.push(d.pcm); this.hadAudio = true; }
      else if (d.type === 'flush') { this.queue = []; this.readOffset = 0; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      while (this.queue.length > 0 && this.readOffset >= this.queue[0].length) {
        this.queue.shift();
        this.readOffset = 0;
      }
      if (this.queue.length === 0) {
        ch[i] = 0;
        if (this.hadAudio) { this.hadAudio = false; this.port.postMessage({ type: 'drained' }); }
      } else {
        ch[i] = this.queue[0][this.readOffset];
        this.readOffset += 1;
      }
    }
    for (let c = 1; c < out.length; c += 1) out[c].set(ch);
    return true;
  }
}
registerProcessor("${PLAYBACK_WORKLET_NAME}", ElizaVoiceSessionDownlink);
`;

export function hasPlaybackWorkletSupport(
  ctx: PlaybackAudioContextLike,
): boolean {
  return (
    typeof ctx.audioWorklet?.addModule === "function" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
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
      const Ctor =
        typeof window !== "undefined"
          ? (window as unknown as {
              AudioContext?: new (o?: { sampleRate?: number }) => PlaybackAudioContextLike;
            }).AudioContext ??
            (window as unknown as {
              webkitAudioContext?: new (o?: {
                sampleRate?: number;
              }) => PlaybackAudioContextLike;
            }).webkitAudioContext
          : undefined;
      if (!Ctor) throw new Error("AudioContext unavailable for playback");
      // Request a 16 kHz context so the pcm16 downlink plays at native rate with
      // no resample; if the platform ignores it (Safari sometimes forces 44.1),
      // the ScriptProcessor/worklet plays the raw samples — a pitch shift the
      // caller can correct later, but correctness of framing/flush is unaffected.
      return new Ctor({ sampleRate: VOICE_PCM_SAMPLE_RATE });
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

  if (hasPlaybackWorkletSupport(ctx)) {
    backend = "audioworklet";
    const url = URL.createObjectURL(
      new Blob([PLAYBACK_WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await ctx.audioWorklet!.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    workletNode = new (AudioWorkletNode as unknown as new (
      c: PlaybackAudioContextLike,
      name: string,
    ) => PlaybackWorkletNodeLike)(ctx, PLAYBACK_WORKLET_NAME);
    workletNode.port.onmessage = (event) => {
      const d = event.data as { type?: string } | undefined;
      if (d?.type === "drained") options.onDrained?.();
    };
    (workletNode as unknown as PlaybackNodeLike).connect(ctx.destination);
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
    await ctx.close().catch(() => {});
    throw new Error("no AudioWorklet or ScriptProcessor for playback");
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
      if (ctx.state === "suspended") {
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
