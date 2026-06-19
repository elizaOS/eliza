import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ElizaVoicePluginLike,
  ElizaVoiceTurn,
  TalkModeAudioFrameEvent,
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

interface FakeVoiceState {
  ctxCreated: number;
  pipelineOpened: number;
  pipelineClosed: number;
  ctxDestroyed: number;
  processed: string[];
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
    pipelineProcess: vi.fn(async ({ pcm16 }) => {
      state.processed.push(pcm16);
      return { turns: state.nextTurns.shift() ?? [] };
    }),
    pipelineFlush: vi.fn(async () => ({
      turns: state.nextTurns.shift() ?? [],
    })),
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
): TalkModePluginLike {
  let listener: ((e: TalkModeAudioFrameEvent) => void) | null = null;
  onFrame((e) => listener?.(e));
  return {
    addListener: vi.fn(
      async (_name: string, cb: (e: TalkModeAudioFrameEvent) => void) => {
        listener = cb;
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

  beforeEach(() => {
    state = {
      ctxCreated: 0,
      pipelineOpened: 0,
      pipelineClosed: 0,
      ctxDestroyed: 0,
      processed: [],
      nextTurns: [],
    };
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
});
