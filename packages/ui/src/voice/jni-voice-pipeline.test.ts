import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ElizaVoicePluginLike,
  ElizaVoiceTurn,
  TalkModeAudioFrameEvent,
  TalkModePlaybackFrameEvent,
  TalkModePluginLike,
} from "../bridge/native-plugins";
import { type JniAttributedTurn, JniVoicePipeline } from "./jni-voice-pipeline";

// atob/btoa exist in jsdom/happy-dom; provide a Node fallback for the runner.
if (typeof globalThis.atob === "undefined") {
  globalThis.atob = (b: string) => Buffer.from(b, "base64").toString("binary");
  globalThis.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
}

/** Encode a 256-float L2-normalized embedding as base64 LE-fp32. */
function encodeEmbedding(): { b64: string; norm: number } {
  const emb = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) emb[i] = (i % 7) - 3;
  let norm = 0;
  for (const v of emb) norm += v * v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 256; i += 1) emb[i] /= norm;
  const bytes = new Uint8Array(emb.buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { b64: btoa(bin), norm: 1 };
}

function makeFrame(samples: number): TalkModeAudioFrameEvent {
  const buf = Buffer.alloc(samples * 2); // silence LE-s16
  return {
    pcm16: buf.toString("base64"),
    sampleRate: 16000,
    channels: 1,
    samples,
    rms: 0,
    timestamp: 0,
    frameIndex: 0,
  };
}

function makePcm16Frame(
  values: readonly number[],
  timestamp = 0,
): TalkModeAudioFrameEvent {
  return {
    pcm16: encodePcm16(values),
    sampleRate: 16000,
    channels: 1,
    samples: values.length,
    rms: Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0) /
        Math.max(1, values.length),
    ),
    timestamp,
    frameIndex: 0,
  };
}

function makePlaybackFrame(
  values: readonly number[],
  timestamp = 0,
  frameIndex = 0,
): TalkModePlaybackFrameEvent {
  return {
    provider: "local-inference",
    pcm16: encodePcm16(values),
    sampleRate: 16000,
    channels: 1,
    samples: values.length,
    timestamp,
    frameIndex,
  };
}

function encodePcm16(values: readonly number[]): string {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    const signed =
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buf.writeInt16LE(signed, index * 2);
  });
  return buf.toString("base64");
}

function decodePcm16(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function rms(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

function encodePcm(values: readonly number[]): string {
  const pcm = new Float32Array(values);
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

interface FakeVoiceState {
  ctxCreated: number;
  pipelineOpened: number;
  pipelineClosed: number;
  ctxDestroyed: number;
  processed: string[];
  includePcmRequests: boolean[];
  nextTurns: ElizaVoiceTurn[][];
}

function fakeVoice(state: FakeVoiceState): ElizaVoicePluginLike {
  return {
    voiceAbiVersion: vi.fn(async () => ({
      loaded: true,
      abi: "7",
      vad: 1,
      wakeword: 1,
      speaker: 1,
      diariz: 1,
    })),
    contextCreate: vi.fn(async () => {
      state.ctxCreated += 1;
      return { handle: "ctx1", bundleDir: "/bundle" };
    }),
    contextDestroy: vi.fn(async () => {
      state.ctxDestroyed += 1;
    }),
    pipelineOpen: vi.fn(async () => {
      state.pipelineOpened += 1;
      return { handle: "pl1" };
    }),
    pipelineProcess: vi.fn(async ({ pcm16, includePcm }) => {
      state.processed.push(pcm16);
      state.includePcmRequests.push(Boolean(includePcm));
      return { turns: state.nextTurns.shift() ?? [] };
    }),
    pipelineFlush: vi.fn(async (options?: { includePcm?: boolean }) => {
      state.includePcmRequests.push(Boolean(options?.includePcm));
      return {
        turns: state.nextTurns.shift() ?? [],
      };
    }),
    pipelineReset: vi.fn(async () => {}),
    pipelineClose: vi.fn(async () => {
      state.pipelineClosed += 1;
    }),
    wakewordOpen: vi.fn(),
    wakewordScore: vi.fn(),
    wakewordReset: vi.fn(),
    wakewordClose: vi.fn(),
  } as unknown as ElizaVoicePluginLike;
}

function fakeTalkmode(
  onFrame: (cb: (e: TalkModeAudioFrameEvent) => void) => void,
  onPlaybackFrame: (
    cb: (e: TalkModePlaybackFrameEvent) => void,
  ) => void = () => {},
): TalkModePluginLike {
  let listener: ((e: TalkModeAudioFrameEvent) => void) | null = null;
  let playbackListener: ((e: TalkModePlaybackFrameEvent) => void) | null = null;
  onFrame((e) => listener?.(e));
  onPlaybackFrame((e) => playbackListener?.(e));
  return {
    addListener: vi.fn(
      async (
        name: string,
        cb:
          | ((e: TalkModeAudioFrameEvent) => void)
          | ((e: TalkModePlaybackFrameEvent) => void),
      ) => {
        if (name === "playbackFrame") {
          playbackListener = cb as (e: TalkModePlaybackFrameEvent) => void;
        } else {
          listener = cb as (e: TalkModeAudioFrameEvent) => void;
        }
        return { remove: vi.fn(async () => {}) };
      },
    ),
    startAudioFrames: vi.fn(async () => ({ started: true })),
    stopAudioFrames: vi.fn(async () => {}),
  } as unknown as TalkModePluginLike;
}

describe("JniVoicePipeline", () => {
  let state: FakeVoiceState;
  let emit: (e: TalkModeAudioFrameEvent) => void = () => {};
  let emitPlayback: (e: TalkModePlaybackFrameEvent) => void = () => {};

  beforeEach(() => {
    state = {
      ctxCreated: 0,
      pipelineOpened: 0,
      pipelineClosed: 0,
      ctxDestroyed: 0,
      processed: [],
      includePcmRequests: [],
      nextTurns: [],
    };
    emit = () => {};
    emitPlayback = () => {};
  });

  it("opens a native context + pipeline on start and frees them on stop", async () => {
    const voice = fakeVoice(state);
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice);
    const started = await p.start();
    expect(started.started).toBe(true);
    expect(state.ctxCreated).toBe(1);
    expect(state.pipelineOpened).toBe(1);
    await p.stop();
    expect(state.pipelineClosed).toBe(1);
    expect(state.ctxDestroyed).toBe(1);
  });

  it("refuses to start when the fused runtime is unavailable", async () => {
    const voice = fakeVoice(state);
    voice.voiceAbiVersion = vi.fn(async () => ({
      loaded: true,
      abi: "7",
      vad: 1,
      wakeword: 1,
      speaker: 0, // speaker missing
      diariz: 1,
    }));
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice);
    const started = await p.start();
    expect(started.started).toBe(false);
    expect(started.error).toContain("speaker=0");
    expect(state.ctxCreated).toBe(0);
  });

  it("batches frames into a single pipelineProcess call (one bridge call per ~1 s)", async () => {
    const voice = fakeVoice(state);
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice);
    await p.start();
    // 49 frames (the cap) triggers exactly one process call.
    for (let i = 0; i < 49; i += 1) emit(makeFrame(320));
    // allow the queued feed microtasks to drain
    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;
    expect(state.processed.length).toBe(1);
    expect(p.framesSent).toBe(49);
    await p.stop();
  });

  it("subtracts native playbackFrame echo before the JNI VAD pipeline sees the mic batch", async () => {
    const voice = fakeVoice(state);
    const tm = fakeTalkmode(
      (cb) => {
        emit = cb;
      },
      (cb) => {
        emitPlayback = cb;
      },
    );
    const p = new JniVoicePipeline(tm, voice);
    await p.start();

    const samples = 49 * 320;
    const far = Array.from({ length: samples }, (_, i) =>
      Math.sin((2 * Math.PI * i) / 53),
    );
    // Android's default seed is 45 ms, so the rendered far-end starts 45 ms
    // before the mic observes the echo in this synthetic loop.
    emitPlayback(makePlaybackFrame(far, -45, 0));
    const echoedMic = far.map((sample) => sample * 0.45);
    for (let i = 0; i < 49; i += 1) {
      emit(makePcm16Frame(echoedMic.slice(i * 320, (i + 1) * 320), i * 20));
    }

    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;

    expect(state.processed.length).toBe(1);
    const cleaned = decodePcm16(state.processed[0]);
    expect(rms(cleaned)).toBeLessThan(rms(new Float32Array(echoedMic)) * 0.75);
    expect(p.playbackFramesReceived).toBe(1);
    await p.stop();
  });

  it("decodes a native turn's embedding + labels and surfaces an attributed turn", async () => {
    const voice = fakeVoice(state);
    const { b64 } = encodeEmbedding();
    // 293 int8 diariz labels, all class 1 (single speaker).
    const labels = new Int8Array(293).fill(1);
    let labelBin = "";
    for (const b of new Uint8Array(labels.buffer))
      labelBin += String.fromCharCode(b);
    const turn: ElizaVoiceTurn = {
      turnId: "jni_0",
      samples: 285184,
      durationMs: 17824,
      hasEmbedding: true,
      embNorm: 1,
      diarizFrames: 293,
      diarizDistinctClasses: 1,
      embedding: b64,
      embeddingDim: 256,
      labels: btoa(labelBin),
      labelCount: 293,
    };
    state.nextTurns = [[turn]];
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice);
    const turns: JniAttributedTurn[] = [];
    p.onTurn((t) => turns.push(t));
    await p.start();
    for (let i = 0; i < 49; i += 1) emit(makeFrame(320));
    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.turnId).toBe("jni_0");
    expect(t.embedding).toHaveLength(256);
    expect(t.embeddingNorm).toBeCloseTo(1, 5);
    expect(t.diarizLabels).toHaveLength(293);
    expect(t.diarizDistinctClasses).toBe(1);
    expect(t.signal).toBeDefined();
    await p.stop();
  });

  it("invokes the injected speaker resolver and feeds attribution into the gate", async () => {
    const voice = fakeVoice(state);
    const { b64 } = encodeEmbedding();
    const turn: ElizaVoiceTurn = {
      turnId: "jni_1",
      samples: 32000,
      durationMs: 2000,
      hasEmbedding: true,
      embNorm: 1,
      diarizFrames: 293,
      diarizDistinctClasses: 1,
      embedding: b64,
      embeddingDim: 256,
      labels: "",
      labelCount: 0,
    };
    state.nextTurns = [[turn]];
    const resolveSpeaker = vi.fn(async () => ({
      entityId: "entity-bystander",
      confidence: 0.95,
      isOwner: false,
    }));
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice, {
      resolveSpeaker,
      knownSpeakerEntityIds: ["entity-owner"],
    });
    const turns: JniAttributedTurn[] = [];
    p.onTurn((t) => turns.push(t));
    await p.start();
    for (let i = 0; i < 49; i += 1) emit(makeFrame(320));
    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;
    expect(resolveSpeaker).toHaveBeenCalledOnce();
    // A confident bystander (not owner, not enrolled, no wake word) is suppressed.
    expect(turns[0].signal.agentShouldSpeak).toBe(false);
    expect(turns[0].signal.nextSpeaker).toBe("user");
    await p.stop();
  });

  it("feeds selfVoiceSimilarity into the ambient gate", async () => {
    const voice = fakeVoice(state);
    const { b64 } = encodeEmbedding();
    const turn: ElizaVoiceTurn = {
      turnId: "jni_self_voice",
      samples: 32000,
      durationMs: 2000,
      hasEmbedding: true,
      embNorm: 1,
      diarizFrames: 293,
      diarizDistinctClasses: 1,
      embedding: b64,
      embeddingDim: 256,
      labels: "",
      labelCount: 0,
    };
    state.nextTurns = [[turn]];
    const resolveSelfVoiceSimilarity = vi.fn(async () => 0.92);
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const p = new JniVoicePipeline(tm, voice, {
      resolveSelfVoiceSimilarity,
      selfVoiceContext: { agentSpeaking: true },
    });
    const turns: JniAttributedTurn[] = [];
    p.onTurn((t) => turns.push(t));
    await p.start();
    for (let i = 0; i < 49; i += 1) emit(makeFrame(320));
    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;

    expect(resolveSelfVoiceSimilarity).toHaveBeenCalledOnce();
    expect(turns[0].signal.agentShouldSpeak).toBe(false);
    expect(turns[0].signal.nextSpeaker).toBe("user");
    expect(turns[0].signal.source).toBe("client-ambient+self-voice");
    await p.stop();
  });

  it("requests completed turn PCM only when the handoff listener is configured", async () => {
    const voice = fakeVoice(state);
    const pcm = [0.125, -0.25, 0.5, -0.75];
    const turn: ElizaVoiceTurn = {
      turnId: "jni_pcm_0",
      samples: pcm.length,
      durationMs: 0.25,
      hasEmbedding: false,
      embNorm: 0,
      diarizFrames: 0,
      diarizDistinctClasses: 0,
      embedding: "",
      embeddingDim: 0,
      labels: "",
      labelCount: 0,
      pcm: encodePcm(pcm),
      pcmSampleRate: 16_000,
    };
    state.nextTurns = [[turn]];
    const tm = fakeTalkmode((cb) => {
      emit = cb;
    });
    const onCompletedPcmTurn = vi.fn();
    const p = new JniVoicePipeline(tm, voice, { onCompletedPcmTurn });
    await p.start();
    for (let i = 0; i < 49; i += 1) emit(makeFrame(320));
    await new Promise((r) => setTimeout(r, 0));
    await (p as unknown as { feeding: Promise<void> }).feeding;

    expect(state.includePcmRequests[0]).toBe(true);
    expect(onCompletedPcmTurn).toHaveBeenCalledOnce();
    const forwarded = onCompletedPcmTurn.mock.calls[0][0];
    expect(forwarded.turnId).toBe("jni_pcm_0");
    expect(forwarded.audio.sampleRate).toBe(16_000);
    expect(Array.from(forwarded.audio.pcm)).toEqual(pcm);
    expect(forwarded.signal).toBeDefined();
    await p.stop();
  });
});
