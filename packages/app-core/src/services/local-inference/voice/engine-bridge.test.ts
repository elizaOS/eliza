/**
 * Tests for the streaming-TTS routing in `engine-bridge.ts`.
 *
 * Covers the `FfiOmniVoiceBackend` ↔ fused `libelizainference` seam W9's
 * scheduler drives:
 *   - when the loaded build advertises streaming TTS
 *     (`tts_stream_supported() == 1`), `synthesizeStream` forwards to
 *     `eliza_inference_tts_synthesize_stream` and the chunk callback runs
 *     per delivered PCM segment;
 *   - when it does NOT, `synthesizeStream` still satisfies the seam — but
 *     with exactly one body chunk + one `isFinal` tail (the batch
 *     forward-pass result), so callers never mistake a non-streaming
 *     build for a streaming one (no fallback sludge);
 *   - `synthesize` (whole-phrase) routes through the streaming entry when
 *     supported and concatenates the chunks;
 *   - `cancelSignal` flips end the stream at the next chunk boundary;
 *   - `StubOmniVoiceBackend` implements the same seam for scheduler tests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import {
  EngineVoiceBridge,
  FfiOmniVoiceBackend,
  isStreamingTtsBackend,
  nativeRejectedRangeToRollbackRange,
  StubOmniVoiceBackend,
  type TtsPcmChunk,
} from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import type { OmniVoiceBackend, Phrase, SpeakerPreset } from "./types";
import { writeVoicePresetFile } from "./voice-preset-format";

function phrase(text: string): Phrase {
  return {
    id: 1,
    text,
    fromIndex: 0,
    toIndex: text.length,
    terminator: "punctuation",
  };
}

function preset(): SpeakerPreset {
  return {
    voiceId: "default",
    embedding: new Float32Array(4),
    bytes: new Uint8Array(0),
  };
}

function writePresetBundle(root: string): void {
  mkdirSync(path.join(root, "cache"), { recursive: true });
  const embedding = new Float32Array(16);
  for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
  writeFileSync(
    path.join(root, "cache", "voice-preset-default.bin"),
    Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
  );
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
  const region: MmapRegionHandle = {
    id: "region-ok",
    path: "/tmp/tts-ok",
    sizeBytes: 1024,
    async evictPages() {},
    async release() {},
  };
  const refc: RefCountedResource = { id: "refc-ok", async release() {} };
  return {
    loadTtsRegion: async () => region,
    loadAsrRegion: async () => region,
    loadVoiceCaches: async () => refc,
    loadVoiceSchedulerNodes: async () => refc,
  };
}

describe("FfiOmniVoiceBackend — streaming TTS routing", () => {
  it("synthesizeStream forwards to the streaming entry when the build supports it", async () => {
    const backend = new FfiOmniVoiceBackend({
      ffi: fakeFfi("ignored", { ttsSamples: 16, ttsStreamSupported: true }),
      ctx: 1n,
      sampleRate: 24_000,
    });
    expect(backend.supportsStreamingTts()).toBe(true);
    const chunks: TtsPcmChunk[] = [];
    const res = await backend.synthesizeStream({
      phrase: phrase("hi there"),
      preset: preset(),
      cancelSignal: { cancelled: false },
      onChunk: (c) => {
        chunks.push({ ...c, pcm: new Float32Array(c.pcm) });
      },
    });
    expect(res.cancelled).toBe(false);
    // fakeFfi emits one body chunk (ttsSamples) + one final tail.
    expect(chunks.map((c) => c.isFinal)).toEqual([false, true]);
    expect(chunks[0]?.pcm.length).toBe(16);
    expect(chunks[0]?.sampleRate).toBe(24_000);
    expect(chunks[1]?.pcm.length).toBe(0);
  });

  it("synthesizeStream collapses to one body chunk + tail on a non-streaming build", async () => {
    const backend = new FfiOmniVoiceBackend({
      ffi: fakeFfi("ignored", { ttsSamples: 9, ttsStreamSupported: false }),
      ctx: 1n,
      sampleRate: 24_000,
    });
    expect(backend.supportsStreamingTts()).toBe(false);
    const chunks: TtsPcmChunk[] = [];
    const res = await backend.synthesizeStream({
      phrase: phrase("hi"),
      preset: preset(),
      cancelSignal: { cancelled: false },
      onChunk: (c) => {
        chunks.push({ ...c, pcm: new Float32Array(c.pcm) });
      },
    });
    expect(res.cancelled).toBe(false);
    expect(chunks.map((c) => c.isFinal)).toEqual([false, true]);
    // Batch path writes `ttsSamples` (= 9) into the caller buffer.
    expect(chunks[0]?.pcm.length).toBe(9);
  });

  it("synthesize routes through the streaming entry and concatenates chunks", async () => {
    const backend = new FfiOmniVoiceBackend({
      ffi: fakeFfi("ignored", { ttsSamples: 7, ttsStreamSupported: true }),
      ctx: 1n,
      sampleRate: 16_000,
    });
    const out = await backend.synthesize({
      phrase: phrase("speak"),
      preset: preset(),
      cancelSignal: { cancelled: false },
    });
    expect(out.pcm.length).toBe(7);
    expect(out.sampleRate).toBe(16_000);
    expect(out.phraseId).toBe(1);
  });

  it("passes NULL for the default speaker preset so OmniVoice uses bundle defaults", async () => {
    const speakerIds: Array<string | null> = [];
    const base = fakeFfi("ignored", {
      ttsSamples: 4,
      ttsStreamSupported: true,
    });
    const backend = new FfiOmniVoiceBackend({
      ffi: {
        ...base,
        ttsSynthesizeStream: (args) => {
          speakerIds.push(args.speakerPresetId);
          return base.ttsSynthesizeStream(args);
        },
      },
      ctx: 1n,
      sampleRate: 24_000,
    });

    await backend.synthesize({
      phrase: phrase("hello"),
      preset: preset(),
      cancelSignal: { cancelled: false },
    });

    expect(speakerIds).toEqual([null]);
  });

  it("preserves non-default speaker preset ids for multi-voice bundles", async () => {
    const speakerIds: Array<string | null> = [];
    const base = fakeFfi("ignored", {
      ttsSamples: 4,
      ttsStreamSupported: false,
    });
    const backend = new FfiOmniVoiceBackend({
      ffi: {
        ...base,
        ttsSynthesize: (args) => {
          speakerIds.push(args.speakerPresetId);
          return base.ttsSynthesize(args);
        },
      },
      ctx: 1n,
      sampleRate: 24_000,
    });

    await backend.synthesize({
      phrase: phrase("hello"),
      preset: { ...preset(), voiceId: "narrator" },
      cancelSignal: { cancelled: false },
    });

    expect(speakerIds).toEqual(["narrator"]);
  });

  it("batch transcribe uses the fused batch ABI with the original sample rate", async () => {
    const seen: Array<{ sampleRateHz: number; samples: number }> = [];
    const base = fakeFfi("ignored", {
      ttsSamples: 4,
      asrStreamSupported: true,
    });
    const backend = new FfiOmniVoiceBackend({
      ffi: {
        ...base,
        asrTranscribe: (args) => {
          seen.push({
            sampleRateHz: args.sampleRateHz,
            samples: args.pcm.length,
          });
          return "Hello, say hello back.";
        },
      },
      ctx: 1n,
      sampleRate: 24_000,
    });

    const transcript = await backend.transcribe({
      pcm: new Float32Array(24_000),
      sampleRate: 24_000,
    });

    expect(transcript).toBe("Hello, say hello back.");
    expect(seen).toEqual([{ sampleRateHz: 24_000, samples: 24_000 }]);
  });

  it("a pre-set cancelSignal short-circuits synthesizeStream before the body chunk", async () => {
    const backend = new FfiOmniVoiceBackend({
      ffi: fakeFfi("ignored", { ttsSamples: 32, ttsStreamSupported: true }),
      ctx: 1n,
    });
    const chunks: TtsPcmChunk[] = [];
    const res = await backend.synthesizeStream({
      phrase: phrase("hello"),
      preset: preset(),
      cancelSignal: { cancelled: true },
      onChunk: (c) => {
        chunks.push(c);
      },
    });
    expect(res.cancelled).toBe(true);
    // The fake always fires the final tail; the body chunk is the one we
    // expect to be skipped — but the fake emits it then we return true,
    // so at most a final tail is observed with isFinal true.
    expect(chunks.every((c) => c.isFinal)).toBe(true);
  });

  it("cancelTts is callable on the FFI backend", () => {
    const backend = new FfiOmniVoiceBackend({
      ffi: fakeFfi("x", { ttsStreamSupported: true }),
      ctx: 1n,
    });
    expect(() => backend.cancelTts()).not.toThrow();
  });
});

describe("nativeRejectedRangeToRollbackRange", () => {
  it("converts native half-open verifier ranges to inclusive rollback ranges", () => {
    expect(
      nativeRejectedRangeToRollbackRange({ rejectedFrom: 3, rejectedTo: 7 }),
    ).toEqual({ fromIndex: 3, toIndex: 6 });
  });

  it("ignores empty and absent native verifier ranges", () => {
    expect(
      nativeRejectedRangeToRollbackRange({ rejectedFrom: -1, rejectedTo: -1 }),
    ).toBeNull();
    expect(
      nativeRejectedRangeToRollbackRange({ rejectedFrom: 5, rejectedTo: 5 }),
    ).toBeNull();
  });
});

describe("StubOmniVoiceBackend — streaming seam", () => {
  it("implements StreamingTtsBackend and emits a fixed number of chunks + final tail", async () => {
    const backend = new StubOmniVoiceBackend(24_000);
    expect(isStreamingTtsBackend(backend)).toBe(true);
    const chunks: TtsPcmChunk[] = [];
    const res = await backend.synthesizeStream({
      phrase: phrase("one sec"),
      preset: preset(),
      cancelSignal: { cancelled: false },
      onChunk: (c) => {
        chunks.push(c);
      },
    });
    expect(res.cancelled).toBe(false);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.at(-1)?.isFinal).toBe(true);
    // Every non-final chunk carries some PCM.
    for (const c of chunks.slice(0, -1)) {
      expect(c.isFinal).toBe(false);
      expect(c.pcm.length).toBeGreaterThan(0);
    }
    expect(backend.streamCalls).toBe(1);
  });

  it("honours a mid-stream cancel via onChunk returning true", async () => {
    const backend = new StubOmniVoiceBackend(24_000);
    let n = 0;
    const res = await backend.synthesizeStream({
      phrase: phrase("got it"),
      preset: preset(),
      cancelSignal: { cancelled: false },
      onChunk: () => {
        n += 1;
        return n === 1; // cancel after the first body chunk
      },
    });
    expect(res.cancelled).toBe(true);
  });
});

describe("EngineVoiceBridge direct synthesis guard", () => {
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-engine-bridge-"));
    writePresetBundle(bundleRoot);
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("rejects direct WAV synthesis on the stub backend", async () => {
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await bridge.arm();

    await expect(bridge.synthesizeTextToWav("hello")).rejects.toMatchObject({
      code: "missing-fused-build",
    });
  });

  it("routes one-shot transcription through the backend batch ABI without resampling first", async () => {
    let observedSampleRate = 0;
    let observedSamples = 0;
    const backend = {
      async synthesize() {
        return {
          phraseId: 0,
          fromIndex: 0,
          toIndex: 0,
          pcm: new Float32Array(1),
          sampleRate: 24_000,
        };
      },
      async transcribe(args: { pcm: Float32Array; sampleRate: number }) {
        observedSampleRate = args.sampleRate;
        observedSamples = args.pcm.length;
        return "Hello, say hello back.";
      },
    } as OmniVoiceBackend & {
      transcribe(args: {
        pcm: Float32Array;
        sampleRate: number;
      }): Promise<string>;
    };
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
      backendOverride: backend,
    });
    await bridge.arm();

    const pcm = new Float32Array(24_000);
    const transcript = await bridge.transcribePcm({
      pcm,
      sampleRate: 24_000,
    });

    expect(transcript).toBe("Hello, say hello back.");
    expect(observedSampleRate).toBe(24_000);
    expect(observedSamples).toBe(24_000);
  });
});
