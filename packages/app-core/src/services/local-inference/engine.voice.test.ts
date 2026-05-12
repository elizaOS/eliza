/**
 * Voice integration test for `LocalInferenceEngine`.
 *
 * Covers the four wiring contracts from this scope:
 *   (a) voice surface starts when the bundle has the required files,
 *   (b) voice surface refuses to start when the FFI library is missing
 *       (no silent fallback to text-only — see AGENTS.md §3 + §9),
 *   (c) DFlash rejection events flow into the rollback queue with the
 *       correct token range,
 *   (d) barge-in trigger drains the ring buffer and cancels in-flight
 *       TTS within one kernel tick (AGENTS.md §4).
 *
 * The text-generation path is intentionally not exercised — the engine
 * is constructed but `load()` is not called, so the dispatcher's
 * llama.cpp side stays cold. This isolates the voice bridge so the test
 * does not depend on a real GGUF on disk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalInferenceEngine } from "./engine";
import {
  AsrUnavailableError,
  defaultLifecycleLoaders,
  type MmapRegionHandle,
  type RefCountedResource,
  VoiceLifecycleError,
  type VoiceLifecycleLoaders,
} from "./voice";
import { VoiceStartupError } from "./voice/engine-bridge";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  ElizaInferenceRegion,
} from "./voice/ffi-bindings";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  RejectedTokenRange,
  SpeakerPreset,
  TextToken,
  VoiceSchedulerTelemetryEvent,
} from "./voice/types";
import { writeVoicePresetFile } from "./voice/voice-preset-format";

function missingWhisperOptions() {
  const root = path.join(tmpdir(), `eliza-missing-whisper-${process.pid}`);
  return {
    binaryPath: path.join(root, "whisper-cli"),
    modelPath: path.join(root, "ggml-base.en.bin"),
  };
}

/**
 * TTS backend whose synthesis only completes when `release()` is
 * called. Lets the rollback test issue a reject while phrases are
 * still in-flight (queued at "synthesizing" in the rollback queue),
 * which is the realistic shape — DFlash rejects propagate fast and
 * frequently outrun TTS.
 */
class DeferredBackend implements OmniVoiceBackend {
  private pending: Array<() => void> = [];
  releaseAll(): void {
    const list = this.pending;
    this.pending = [];
    for (const r of list) r();
  }
  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    await new Promise<void>((resolve) => this.pending.push(resolve));
    args.onKernelTick?.();
    const pcm = new Float32Array(8);
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm,
      sampleRate: 24000,
    };
  }
}

class CountingBackend implements OmniVoiceBackend {
  calls = 0;
  texts: string[] = [];

  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    this.calls++;
    this.texts.push(args.phrase.text);
    args.onKernelTick?.();
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm: new Float32Array([0.25, -0.25]),
      sampleRate: 24000,
    };
  }
}

function tok(index: number, text: string): TextToken {
  return { index, text };
}

function writePresetBundle(
  root: string,
  phrases: Array<{ text: string; sampleRate: number; pcm: Float32Array }> = [],
): void {
  mkdirSync(path.join(root, "cache"), { recursive: true });
  // 16 floats — enough for the speaker preset cache to parse without
  // truncating to zero. Real presets are O(KB-MB); shape only matters
  // for the integration test. Wrap in the v1 binary format the parser
  // now requires (see voice-preset-format.ts).
  const embedding = new Float32Array(16);
  for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
  const bytes = writeVoicePresetFile({ embedding, phrases });
  writeFileSync(
    path.join(root, "cache", "voice-preset-default.bin"),
    Buffer.from(bytes),
  );
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
  const tts: MmapRegionHandle = {
    id: "tts-ok",
    path: "/tmp/tts-ok",
    sizeBytes: 1024,
    async evictPages() {},
    async release() {},
  };
  const asr: MmapRegionHandle = {
    id: "asr-ok",
    path: "/tmp/asr-ok",
    sizeBytes: 1024,
    async evictPages() {},
    async release() {},
  };
  const caches: RefCountedResource = {
    id: "caches-ok",
    async release() {},
  };
  const nodes: RefCountedResource = {
    id: "nodes-ok",
    async release() {},
  };
  return {
    loadTtsRegion: async () => tts,
    loadAsrRegion: async () => asr,
    loadVoiceCaches: async () => caches,
    loadVoiceSchedulerNodes: async () => nodes,
  };
}

function fakeFfi(calls: string[]): ElizaInferenceFfi {
  return {
    libraryPath: "/tmp/libelizainference-test.dylib",
    libraryAbiVersion: "2",
    create: () => 1n,
    destroy(ctx: ElizaInferenceContextHandle) {
      calls.push(`destroy:${ctx.toString()}`);
    },
    mmapAcquire(_ctx, region: ElizaInferenceRegion) {
      calls.push(`acquire:${region}`);
    },
    mmapEvict(_ctx, region: ElizaInferenceRegion) {
      calls.push(`evict:${region}`);
    },
    ttsSynthesize() {
      throw new Error("not used by this test");
    },
    asrTranscribe() {
      throw new Error("not used by this test");
    },
    // Streaming TTS + verifier callback ABI v2 — unused by this test.
    ttsStreamSupported: () => false,
    ttsSynthesizeStream() {
      throw new Error("not used by this test");
    },
    cancelTts() {
      /* no-op */
    },
    setVerifierCallback: () => ({ close: () => {} }),
    // Streaming ASR ABI v2 — this fake reports no working decoder, so the
    // adapter chain falls through to the whisper.cpp interim path.
    asrStreamSupported: () => false,
    asrStreamOpen() {
      throw new Error("not used by this test");
    },
    asrStreamFeed() {
      throw new Error("not used by this test");
    },
    asrStreamPartial() {
      throw new Error("not used by this test");
    },
    asrStreamFinish() {
      throw new Error("not used by this test");
    },
    asrStreamClose() {
      /* no-op */
    },
    close() {
      calls.push("close");
    },
  };
}

function fakeFfiWithAsrAcquireError(
  calls: string[],
  error: VoiceLifecycleError,
): ElizaInferenceFfi {
  return {
    ...fakeFfi(calls),
    mmapAcquire(_ctx, region: ElizaInferenceRegion) {
      calls.push(`acquire:${region}`);
      if (region === "asr") throw error;
    },
  };
}

describe("LocalInferenceEngine voice surface", () => {
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-voice-bundle-"));
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("(a) starts voice when the bundle has the required preset", () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
    });
    expect(engine.voice()).toBe(bridge);
    expect(bridge.scheduler.preset.embedding.length).toBeGreaterThan(0);
    expect(bridge.bundlePath()).toBe(bundleRoot);
  });

  it("(a) refuses to start twice without stopVoice in between", () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    engine.startVoice({ bundleRoot, useFfiBackend: false });
    expect(() =>
      engine.startVoice({ bundleRoot, useFfiBackend: false }),
    ).toThrow(VoiceStartupError);
  });

  it("(b) refuses to start when the FFI library is missing", () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    const previousManagedLookup = process.env.ELIZA_INFERENCE_MANAGED_LOOKUP;
    process.env.ELIZA_INFERENCE_MANAGED_LOOKUP = "0";
    let thrown: unknown;
    try {
      engine.startVoice({ bundleRoot, useFfiBackend: true });
    } catch (err) {
      thrown = err;
    } finally {
      if (previousManagedLookup === undefined) {
        delete process.env.ELIZA_INFERENCE_MANAGED_LOOKUP;
      } else {
        process.env.ELIZA_INFERENCE_MANAGED_LOOKUP = previousManagedLookup;
      }
    }
    expect(thrown).toBeInstanceOf(VoiceStartupError);
    if (thrown instanceof VoiceStartupError) {
      expect(thrown.code).toBe("missing-ffi");
      expect(thrown.message).toMatch(/omnivoice/i);
    }
  });

  it("(b) refuses to start when the speaker preset is missing", () => {
    // bundleRoot has no cache/ — the preset check must fire first.
    const engine = new LocalInferenceEngine();
    let thrown: unknown;
    try {
      engine.startVoice({ bundleRoot, useFfiBackend: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VoiceStartupError);
    if (thrown instanceof VoiceStartupError) {
      expect(thrown.code).toBe("missing-speaker-preset");
    }
  });

  it("seeds the phrase cache from the speaker preset bundle", async () => {
    writePresetBundle(bundleRoot, [
      {
        text: "sure.",
        sampleRate: 24000,
        pcm: new Float32Array([0.5, 0.5, 0.5]),
      },
    ]);
    const backend = new CountingBackend();
    const audio: AudioChunk[] = [];
    const telemetry: VoiceSchedulerTelemetryEvent[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      events: {
        onAudio: (chunk) => audio.push(chunk),
        onTelemetry: (event) => telemetry.push(event),
      },
    });

    await engine.pushAcceptedTokens([tok(0, "Sure"), tok(1, ".")]);
    await engine.voice()?.settle();

    expect(backend.calls).toBe(0);
    expect(audio).toHaveLength(1);
    expect(Array.from(audio[0].pcm)).toEqual([0.5, 0.5, 0.5]);
    expect(telemetry.map((event) => event.type)).toEqual([
      "phrase-dispatch",
      "phrase-cache-hit",
      "tts-first-audio",
      "audio-committed",
    ]);
    expect(
      telemetry.find((event) => event.type === "phrase-cache-hit"),
    ).toMatchObject({
      phrase: { text: "Sure." },
    });
    expect(
      telemetry.find((event) => event.type === "tts-first-audio"),
    ).toMatchObject({
      source: "cache",
      samples: 3,
      sampleRate: 24000,
    });
  });

  it("requires an armed voice lifecycle for direct TEXT_TO_SPEECH synthesis", async () => {
    const engine = new LocalInferenceEngine();
    await expect(engine.synthesizeSpeech("hello")).rejects.toMatchObject({
      code: "not-started",
    });

    writePresetBundle(bundleRoot);
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await expect(engine.synthesizeSpeech("hello")).rejects.toMatchObject({
      code: "illegal-transition",
    });
  });

  it("direct TEXT_TO_SPEECH returns WAV bytes and preserves singing/emotion tags", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const telemetry: VoiceSchedulerTelemetryEvent[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
      events: {
        onTelemetry: (event) => telemetry.push(event),
      },
    });
    await engine.armVoice();

    const expressiveText = "[singing] [happy] la la la [laughter].";
    const wav = await engine.synthesizeSpeech(expressiveText);

    expect(backend.calls).toBe(1);
    expect(backend.texts).toEqual([expressiveText]);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(telemetry.map((event) => event.type)).toEqual([
      "phrase-cache-miss",
      "tts-start",
      "tts-first-audio",
    ]);
    expect(telemetry[0]).toMatchObject({
      type: "phrase-cache-miss",
      phrase: { text: expressiveText },
    });
    await engine.stopVoice();
  });

  it("emits structured scheduler telemetry for phrase dispatch, cache miss, TTS, and audio commit", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const telemetry: VoiceSchedulerTelemetryEvent[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      events: {
        onTelemetry: (event) => telemetry.push(event),
      },
    });

    await engine.pushAcceptedTokens([tok(0, "Sure"), tok(1, ".")]);
    await engine.voice()?.settle();

    expect(backend.calls).toBe(1);
    expect(telemetry.map((event) => event.type)).toEqual([
      "phrase-dispatch",
      "phrase-cache-miss",
      "tts-start",
      "tts-first-audio",
      "audio-committed",
    ]);
    expect(telemetry[0]).toMatchObject({
      type: "phrase-dispatch",
      phrase: {
        text: "Sure.",
        fromIndex: 0,
        toIndex: 1,
        tokenCount: 2,
      },
    });
    expect(
      telemetry.find((event) => event.type === "tts-first-audio"),
    ).toMatchObject({
      source: "synthesis",
      samples: 2,
      sampleRate: 24000,
    });
    expect(
      telemetry.find((event) => event.type === "audio-committed"),
    ).toMatchObject({
      source: "synthesis",
      samples: 2,
      flushedSamples: 2,
      paused: false,
      ringBufferSamples: 0,
      sinkBufferedSamples: 2,
    });
  });

  it("prewarms phrase audio so repeated local TTS avoids a backend pass", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();

    const warmed = await engine.prewarmVoicePhrases(["hello there."], {
      concurrency: 1,
    });
    expect(warmed).toEqual({ warmed: 1, cached: 0 });
    expect(backend.calls).toBe(1);

    await engine.synthesizeSpeech("Hello there.");
    expect(backend.calls).toBe(1);
    await engine.stopVoice();
  });

  it("pipes streamed local text chunks into the voice scheduler while generating", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const audio: AudioChunk[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
      events: {
        onAudio: (chunk) => audio.push(chunk),
      },
    });
    await engine.armVoice();

    (
      engine as unknown as {
        dispatcher: {
          generate(args: {
            onTextChunk?: (chunk: string) => Promise<void> | void;
          }): Promise<string>;
        };
      }
    ).dispatcher = {
      async generate(args) {
        await args.onTextChunk?.("Sure");
        await args.onTextChunk?.(".");
        return "Sure.";
      },
    };

    const result = await engine.generate({ prompt: "answer briefly" });

    expect(result).toBe("Sure.");
    expect(backend.calls).toBe(1);
    expect(backend.texts).toEqual(["Sure."]);
    expect(audio).toHaveLength(1);
    await engine.stopVoice();
  });

  it("extracts replyText from structured response streams before voice scheduling", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const audio: AudioChunk[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
      events: {
        onAudio: (chunk) => audio.push(chunk),
      },
    });
    await engine.armVoice();

    (
      engine as unknown as {
        dispatcher: {
          generate(args: {
            onTextChunk?: (chunk: string) => Promise<void> | void;
          }): Promise<string>;
        };
      }
    ).dispatcher = {
      async generate(args) {
        await args.onTextChunk?.(
          '{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],',
        );
        await args.onTextChunk?.('"replyText":"On it ');
        await args.onTextChunk?.('now.","facts":[]}');
        return '{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],"replyText":"On it now.","facts":[]}';
      },
    };

    const result = await engine.generate({
      prompt: "answer briefly",
      streamStructured: true,
      responseSkeleton: {
        spans: [
          { kind: "literal", value: '{"shouldRespond":' },
          { kind: "free-string", key: "shouldRespond" },
          { kind: "literal", value: ',"contexts":' },
          { kind: "free-json", key: "contexts" },
          { kind: "literal", value: ',"intents":' },
          { kind: "free-json", key: "intents" },
          { kind: "literal", value: ',"replyText":' },
          { kind: "free-string", key: "replyText" },
          { kind: "literal", value: ',"facts":' },
          { kind: "free-json", key: "facts" },
          { kind: "literal", value: "}" },
        ],
      },
    });

    expect(result).toContain('"replyText":"On it now."');
    expect(backend.calls).toBeGreaterThan(0);
    expect(backend.texts.join("")).toBe("On it now.");
    expect(backend.texts.join("")).not.toContain("shouldRespond");
    expect(audio.length).toBe(backend.calls);
    await engine.stopVoice();
  });

  it("uses verifier events for voice streaming without duplicating text chunks", async () => {
    writePresetBundle(bundleRoot);
    const backend = new CountingBackend();
    const audio: AudioChunk[] = [];
    const verifierEvents: string[] = [];
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
      events: {
        onAudio: (chunk) => audio.push(chunk),
      },
    });
    await engine.armVoice();

    (
      engine as unknown as {
        dispatcher: {
          generate(args: {
            onTextChunk?: (chunk: string) => Promise<void> | void;
            onVerifierEvent?: (event: {
              kind: "accept";
              tokens: Array<{ index: number; text: string }>;
            }) => Promise<void> | void;
          }): Promise<string>;
        };
      }
    ).dispatcher = {
      async generate(args) {
        await args.onVerifierEvent?.({
          kind: "accept",
          tokens: [{ index: 0, text: "Sure" }],
        });
        verifierEvents.push("accept:Sure");
        await args.onTextChunk?.("Sure");
        await args.onVerifierEvent?.({
          kind: "accept",
          tokens: [{ index: 1, text: "." }],
        });
        verifierEvents.push("accept:.");
        await args.onTextChunk?.(".");
        return "Sure.";
      },
    };

    const result = await engine.generate({ prompt: "answer briefly" });

    expect(result).toBe("Sure.");
    expect(verifierEvents).toEqual(["accept:Sure", "accept:."]);
    expect(backend.calls).toBe(1);
    expect(backend.texts).toEqual(["Sure."]);
    expect(audio).toHaveLength(1);
    await engine.stopVoice();
  });

  it("direct TRANSCRIPTION requires voice and surfaces missing ASR backend clearly", async () => {
    const engine = new LocalInferenceEngine();
    const audio = { pcm: new Float32Array([0]), sampleRate: 24000 };
    // No voice session yet → the bridge accessor fails.
    await expect(engine.transcribePcm(audio)).rejects.toMatchObject({
      code: "not-started",
    });

    writePresetBundle(bundleRoot);
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
      whisper: missingWhisperOptions(),
    });
    await engine.armVoice();
    // Voice is armed but there is no fused ASR (stub backend, no `asr/`
    // dir, no whisper.cpp binary in this env) → the streaming-transcriber
    // adapter chain hard-fails with AsrUnavailableError. No silent empty
    // transcript (AGENTS.md §3 + §9).
    await expect(engine.transcribePcm(audio)).rejects.toBeInstanceOf(
      AsrUnavailableError,
    );
    await engine.stopVoice();
  });

  it("(c) DFlash rejection events flow into the rollback queue with the correct range", async () => {
    writePresetBundle(bundleRoot);
    const rollbackEvents: Array<{
      phraseId: number;
      range: RejectedTokenRange;
    }> = [];
    const telemetry: VoiceSchedulerTelemetryEvent[] = [];
    const phrases: Phrase[] = [];
    const engine = new LocalInferenceEngine();
    const backend = new DeferredBackend();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      // Small phrase cap so the test can drive multiple phrases with a
      // handful of tokens.
      maxTokensPerPhrase: 3,
      events: {
        onPhrase: (p) => phrases.push(p),
        onRollback: (phraseId, range) =>
          rollbackEvents.push({ phraseId, range }),
        onTelemetry: (event) => telemetry.push(event),
      },
    });

    // Push 6 accepted tokens — at maxTokensPerPhrase=3, this yields two
    // phrases (indices 0..2 and 3..5). Synthesis stays deferred so the
    // phrases are still queued in the rollback queue when reject fires.
    await engine.pushAcceptedTokens([
      tok(0, "hello"),
      tok(1, "world"),
      tok(2, "."),
      tok(3, "again"),
      tok(4, "from"),
      tok(5, "."),
    ]);
    expect(phrases.length).toBe(2);
    expect(phrases[0]).toMatchObject({ fromIndex: 0, toIndex: 2 });
    expect(phrases[1]).toMatchObject({ fromIndex: 3, toIndex: 5 });

    // Reject the second phrase's token range. Rollback queue MUST emit
    // exactly one event for the overlapping phrase.
    await engine.pushVerifierEvent({
      kind: "reject",
      tokens: [tok(4, "from"), tok(5, ".")],
    });

    expect(rollbackEvents.length).toBe(1);
    expect(rollbackEvents[0].phraseId).toBe(phrases[1].id);
    expect(rollbackEvents[0].range).toEqual({ fromIndex: 4, toIndex: 5 });

    // First phrase must NOT be rolled back — its token range is disjoint.
    expect(rollbackEvents.some((e) => e.phraseId === phrases[0].id)).toBe(
      false,
    );
    expect(telemetry.find((event) => event.type === "rollback")).toMatchObject({
      type: "rollback",
      phraseId: phrases[1].id,
      range: { fromIndex: 4, toIndex: 5 },
      reason: "rejected-tokens",
    });
    expect(
      telemetry.find((event) => event.type === "tts-cancel"),
    ).toMatchObject({
      type: "tts-cancel",
      phrase: { id: phrases[1].id },
      reason: "rollback",
    });

    backend.releaseAll();
    await engine.stopVoice();
  });

  it("(e) lifecycle defaults to voice-off; armVoice() arms; stopVoice() disarms with evictPages called", async () => {
    writePresetBundle(bundleRoot);
    const tts: MmapRegionHandle & { evictCalls: number } = {
      id: "test-tts",
      path: "/tmp/test-tts",
      sizeBytes: 1024,
      evictCalls: 0,
      async evictPages() {
        tts.evictCalls++;
      },
      async release() {},
    };
    const asr: MmapRegionHandle & { evictCalls: number } = {
      id: "test-asr",
      path: "/tmp/test-asr",
      sizeBytes: 1024,
      evictCalls: 0,
      async evictPages() {
        asr.evictCalls++;
      },
      async release() {},
    };
    const caches: RefCountedResource = {
      id: "test-caches",
      async release() {},
    };
    const nodes: RefCountedResource = {
      id: "test-nodes",
      async release() {},
    };
    const loaders: VoiceLifecycleLoaders = {
      loadTtsRegion: async () => tts,
      loadAsrRegion: async () => asr,
      loadVoiceCaches: async () => caches,
      loadVoiceSchedulerNodes: async () => nodes,
    };
    const engine = new LocalInferenceEngine();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: loaders,
    });
    // Default state is voice-off — heavy resources NOT loaded.
    expect(bridge.lifecycle.current().kind).toBe("voice-off");
    expect(tts.evictCalls).toBe(0);

    await engine.armVoice();
    expect(bridge.lifecycle.current().kind).toBe("voice-on");

    await engine.stopVoice();
    // Disarm path called evictPages on both TTS + ASR mmap regions.
    expect(tts.evictCalls).toBe(1);
    expect(asr.evictCalls).toBe(1);
    expect(bridge.lifecycle.current().kind).toBe("voice-off");
  });

  it("(e) default loaders keep voice assets unmapped until arm, then acquire/evict through FFI", async () => {
    writePresetBundle(bundleRoot);
    mkdirSync(path.join(bundleRoot, "tts"), { recursive: true });
    mkdirSync(path.join(bundleRoot, "asr"), { recursive: true });
    writeFileSync(path.join(bundleRoot, "tts", "omnivoice-test.gguf"), "tts");
    writeFileSync(path.join(bundleRoot, "asr", "asr-test.gguf"), "asr");

    const calls: string[] = [];
    const engine = new LocalInferenceEngine();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: defaultLifecycleLoaders(bundleRoot, fakeFfi(calls), 1n),
    });

    // Voice-off mode must not map TTS/ASR pages or duplicate model
    // parameters. Creating the bridge only loads the tiny preset +
    // scheduler scaffolding.
    expect(bridge.lifecycle.current().kind).toBe("voice-off");
    expect(calls).toEqual([]);

    await engine.armVoice();
    expect(bridge.lifecycle.current().kind).toBe("voice-on");
    expect(calls).toEqual(["acquire:tts", "acquire:asr"]);

    await engine.stopVoice();
    expect(calls).toEqual([
      "acquire:tts",
      "acquire:asr",
      "evict:tts",
      "evict:asr",
    ]);
    expect(bridge.lifecycle.current().kind).toBe("voice-off");
  });

  it("(e) default loaders refuse to arm when ASR assets are missing", async () => {
    writePresetBundle(bundleRoot);
    mkdirSync(path.join(bundleRoot, "tts"), { recursive: true });
    writeFileSync(path.join(bundleRoot, "tts", "omnivoice-test.gguf"), "tts");

    const calls: string[] = [];
    const engine = new LocalInferenceEngine();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: defaultLifecycleLoaders(bundleRoot, fakeFfi(calls), 1n),
    });

    expect(bridge.asrAvailable).toBe(false);

    await expect(engine.armVoice()).rejects.toMatchObject({
      code: "mmap-fail",
    });
    expect(calls).toEqual(["acquire:tts", "evict:tts"]);
    expect(bridge.lifecycle.current().kind).toBe("voice-error");
  });

  it("(e) default loaders acquire the real ASR region and preserve fused ABI errors", async () => {
    writePresetBundle(bundleRoot);
    mkdirSync(path.join(bundleRoot, "tts"), { recursive: true });
    mkdirSync(path.join(bundleRoot, "asr"), { recursive: true });
    writeFileSync(path.join(bundleRoot, "tts", "omnivoice-test.gguf"), "tts");
    writeFileSync(path.join(bundleRoot, "asr", "asr-test.gguf"), "asr");

    const calls: string[] = [];
    const fusedError = new VoiceLifecycleError(
      "kernel-missing",
      "[ffi-bindings] eliza_inference_mmap_acquire(asr) rc=-1: ASR runtime not implemented",
    );
    const engine = new LocalInferenceEngine();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: defaultLifecycleLoaders(
        bundleRoot,
        fakeFfiWithAsrAcquireError(calls, fusedError),
        1n,
      ),
    });

    await expect(engine.armVoice()).rejects.toBe(fusedError);
    expect(calls).toEqual(["acquire:tts", "acquire:asr", "evict:tts"]);
    expect(bridge.lifecycle.current()).toMatchObject({
      kind: "voice-error",
      error: fusedError,
    });
  });

  it("(e) RAM-pressure during arm surfaces VoiceLifecycleError — no silent fallback", async () => {
    writePresetBundle(bundleRoot);
    const loaders: VoiceLifecycleLoaders = {
      loadTtsRegion: async () => {
        throw new Error("ENOMEM: out of memory mapping TTS weights");
      },
      loadAsrRegion: async () => {
        throw new Error("unreachable");
      },
      loadVoiceCaches: async () => {
        throw new Error("unreachable");
      },
      loadVoiceSchedulerNodes: async () => {
        throw new Error("unreachable");
      },
    };
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: loaders,
    });
    let thrown: unknown;
    try {
      await engine.armVoice();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VoiceLifecycleError);
    if (thrown instanceof VoiceLifecycleError) {
      expect(thrown.code).toBe("ram-pressure");
    }
    // Voice surface remains startable but lifecycle is in voice-error
    // until reset. The engine surfaced the structured error rather
    // than degrading silently to text-only.
    expect(engine.voice()?.lifecycle.current().kind).toBe("voice-error");
  });

  it("(d) barge-in drains the ring buffer and cancels in-flight TTS within one kernel tick", async () => {
    writePresetBundle(bundleRoot);
    let cancelObserved = false;
    const telemetry: VoiceSchedulerTelemetryEvent[] = [];
    const engine = new LocalInferenceEngine();
    const backend = new DeferredBackend();
    const bridge = engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      maxTokensPerPhrase: 3,
      events: {
        onCancel: () => {
          cancelObserved = true;
        },
        onTelemetry: (event) => telemetry.push(event),
      },
    });

    // Push three tokens to dispatch a phrase. The deferred backend
    // holds synthesis open, so the in-flight cancelSignal is reachable.
    await engine.pushAcceptedTokens([tok(0, "hi"), tok(1, "."), tok(2, "ok")]);

    // Snapshot the in-flight cancel signal before barge-in. There must
    // be at least one — synthesis is deferred.
    const ticksBefore = bridge.scheduler.kernelTickCount();

    engine.triggerBargeIn();

    // (i) Cancel callback fired synchronously.
    expect(cancelObserved).toBe(true);
    // (ii) Ring buffer drained — empty after barge-in.
    expect(bridge.scheduler.ringBuffer.size()).toBe(0);
    // (iii) Audio sink reports zero buffered samples after drain.
    expect(bridge.scheduler.sink.bufferedSamples()).toBe(0);
    // (iv) Barge-in completed without spinning extra kernel ticks —
    // the contract is "<= 1 kernel tick".
    const ticksAfter = bridge.scheduler.kernelTickCount();
    expect(ticksAfter - ticksBefore).toBeLessThanOrEqual(1);
    expect(
      telemetry.find((event) => event.type === "tts-cancel"),
    ).toMatchObject({
      type: "tts-cancel",
      reason: "barge-in",
    });
    expect(telemetry.find((event) => event.type === "barge-in")).toMatchObject({
      type: "barge-in",
      ringBufferSamplesDrained: 0,
      sinkBufferedSamplesDrained: 0,
      inFlightPhrasesCancelled: 1,
      wasPaused: false,
    });

    // Release the deferred synthesis so settle() can resolve cleanly.
    backend.releaseAll();
    await engine.stopVoice();
  });

  it("triggerBargeIn aborts an in-flight generation's AbortSignal", async () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();

    let observedSignal: AbortSignal | undefined;
    (
      engine as unknown as {
        dispatcher: {
          generate(args: { signal?: AbortSignal }): Promise<string>;
        };
      }
    ).dispatcher = {
      async generate(args) {
        observedSignal = args.signal;
        // Park until barge-in trips the signal.
        await new Promise<void>((resolve) => {
          if (args.signal?.aborted) return resolve();
          args.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return "";
      },
    };

    const gen = engine.generate({ prompt: "..." });
    await new Promise((r) => setTimeout(r, 5));
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
    engine.triggerBargeIn();
    await gen;
    expect(observedSignal?.aborted).toBe(true);
    await engine.stopVoice();
  });
});

/** Minimal `SileroLike` so tests can build a `VadDetector` without ONNX. */
class NoopSilero {
  readonly windowSamples = 512;
  readonly sampleRate = 16_000;
  async process(): Promise<number> {
    return 0;
  }
  reset(): void {}
}

describe("LocalInferenceEngine.startVoiceSession", () => {
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-voice-session-"));
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("requires an armed voice bridge", async () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    await expect(
      engine.startVoiceSession({
        roomId: "r",
        generate: async () => ({ transcript: "", replyText: "" }),
      }),
    ).rejects.toMatchObject({ code: "not-started" });

    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await expect(
      engine.startVoiceSession({
        roomId: "r",
        generate: async () => ({ transcript: "", replyText: "" }),
      }),
    ).rejects.toMatchObject({ code: "not-started" });
  });

  it("refuses to run a live session on the StubOmniVoiceBackend (it emits silence)", async () => {
    writePresetBundle(bundleRoot);
    const engine = new LocalInferenceEngine();
    // No backendOverride → the bridge uses StubOmniVoiceBackend.
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();
    await expect(
      engine.startVoiceSession({
        roomId: "r",
        generate: async () => ({ transcript: "", replyText: "" }),
        vad: undefined,
      }),
    ).rejects.toMatchObject({ code: "missing-fused-build" });
    await engine.stopVoice();
  });

  it("fails loudly with the missing component when no ASR backend is available", async () => {
    writePresetBundle(bundleRoot);
    const { VadDetector } = await import("./voice/vad");
    const { PushMicSource } = await import("./voice/mic-source");
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
      whisper: missingWhisperOptions(),
    });
    await engine.armVoice();
    // Inject a VAD (no ONNX) + a push mic source so the only missing piece
    // is the ASR backend (no fused decoder, no whisper.cpp in this env).
    await expect(
      engine.startVoiceSession({
        roomId: "r",
        generate: async () => ({ transcript: "", replyText: "" }),
        vad: new VadDetector(new NoopSilero()),
        micSource: new PushMicSource({ sampleRate: 16_000, frameSamples: 512 }),
      }),
    ).rejects.toBeInstanceOf(AsrUnavailableError);
    await engine.stopVoice();
  });
});
