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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalInferenceEngine } from "./engine";
import { VoiceStartupError } from "./voice/engine-bridge";
import {
  VoiceLifecycleError,
  type MmapRegionHandle,
  type RefCountedResource,
  type VoiceLifecycleLoaders,
} from "./voice";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  RejectedTokenRange,
  SpeakerPreset,
  TextToken,
} from "./voice/types";
import { writeVoicePresetFile } from "./voice/voice-preset-format";

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
    let thrown: unknown;
    try {
      engine.startVoice({ bundleRoot, useFfiBackend: true });
    } catch (err) {
      thrown = err;
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
    const engine = new LocalInferenceEngine();
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      events: {
        onAudio: (chunk) => audio.push(chunk),
      },
    });

    await engine.pushAcceptedTokens([tok(0, "Sure"), tok(1, ".")]);
    await engine.voice()?.settle();

    expect(backend.calls).toBe(0);
    expect(audio).toHaveLength(1);
    expect(Array.from(audio[0].pcm)).toEqual([0.5, 0.5, 0.5]);
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

  it("direct TEXT_TO_SPEECH returns WAV bytes and does not block singing text", async () => {
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

    const wav = await engine.synthesizeSpeech("[singing] la la la.");

    expect(backend.calls).toBe(1);
    expect(backend.texts).toEqual(["[singing] la la la."]);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    await engine.stopVoice();
  });

  it("direct TRANSCRIPTION requires voice and surfaces missing ASR backend clearly", async () => {
    const engine = new LocalInferenceEngine();
    const audio = { pcm: new Float32Array([0]), sampleRate: 24000 };
    await expect(engine.transcribePcm(audio)).rejects.toMatchObject({
      code: "not-started",
    });

    writePresetBundle(bundleRoot);
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: new CountingBackend(),
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();
    await expect(engine.transcribePcm(audio)).rejects.toMatchObject({
      code: "missing-fused-build",
    });
    await engine.stopVoice();
  });

  it("(c) DFlash rejection events flow into the rollback queue with the correct range", async () => {
    writePresetBundle(bundleRoot);
    const rollbackEvents: Array<{
      phraseId: number;
      range: RejectedTokenRange;
    }> = [];
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
    expect(
      rollbackEvents.some((e) => e.phraseId === phrases[0].id),
    ).toBe(false);

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

    // Release the deferred synthesis so settle() can resolve cleanly.
    backend.releaseAll();
    await engine.stopVoice();
  });
});
