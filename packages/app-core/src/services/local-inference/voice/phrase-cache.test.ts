import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineVoiceBridge, StubOmniVoiceBackend } from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import {
  canonicalizePhraseText,
  DEFAULT_PHRASE_CACHE_SEED,
  FIRST_AUDIO_FILLERS,
  PhraseCache,
} from "./phrase-cache";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
} from "./types";
import { writeVoicePresetFile } from "./voice-preset-format";

// --- the canonical seed/filler constants -----------------------------------

describe("DEFAULT_PHRASE_CACHE_SEED", () => {
  it("is non-empty and stored in canonical form (lowercase, single-spaced, trimmed)", () => {
    expect(DEFAULT_PHRASE_CACHE_SEED.length).toBeGreaterThan(5);
    for (const text of DEFAULT_PHRASE_CACHE_SEED) {
      expect(text).toBe(canonicalizePhraseText(text));
    }
  });

  it("has no duplicates", () => {
    expect(new Set(DEFAULT_PHRASE_CACHE_SEED).size).toBe(
      DEFAULT_PHRASE_CACHE_SEED.length,
    );
  });

  it("includes the documented common openers/acks", () => {
    for (const phrase of ["okay", "got it", "one sec", "hmm", "okay so"]) {
      expect(DEFAULT_PHRASE_CACHE_SEED).toContain(phrase);
    }
  });
});

describe("FIRST_AUDIO_FILLERS", () => {
  it("is a non-empty subset of DEFAULT_PHRASE_CACHE_SEED", () => {
    expect(FIRST_AUDIO_FILLERS.length).toBeGreaterThan(0);
    const seed = new Set(DEFAULT_PHRASE_CACHE_SEED);
    for (const filler of FIRST_AUDIO_FILLERS) {
      expect(seed.has(filler)).toBe(true);
    }
  });
});

// --- PhraseCache LRU semantics (new symbols) -------------------------------

describe("PhraseCache LRU", () => {
  it("get() promotes an entry to most-recently-used", () => {
    const c = new PhraseCache({ maxEntries: 2 });
    c.put({ text: "a", pcm: new Float32Array([1]), sampleRate: 24000 });
    c.put({ text: "b", pcm: new Float32Array([2]), sampleRate: 24000 });
    // Touch "a" — now "b" is the LRU.
    expect(c.get("a")).toBeDefined();
    c.put({ text: "c", pcm: new Float32Array([3]), sampleRate: 24000 });
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });
});

// --- engine-bridge prewarm / filler gating ---------------------------------

class RecordingBackend implements OmniVoiceBackend {
  readonly synthesized: string[] = [];
  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    this.synthesized.push(args.phrase.text);
    args.onKernelTick?.();
    // Distinct non-zero PCM so the phrase cache holds real audio.
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm: new Float32Array([0.3, -0.3, 0.2]),
      sampleRate: 24000,
    };
  }
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
  const region: MmapRegionHandle = {
    id: "region-ok",
    path: "/tmp/region-ok",
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

function writePresetBundle(root: string): void {
  mkdirSync(path.join(root, "cache"), { recursive: true });
  const embedding = new Float32Array(8);
  for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
  writeFileSync(
    path.join(root, "cache", "voice-preset-default.bin"),
    Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
  );
}

describe("EngineVoiceBridge phrase prewarm + first-audio filler", () => {
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-phrase-cache-"));
    writePresetBundle(bundleRoot);
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("hasRealTtsBackend() is false for the stub backend", () => {
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
    });
    expect(bridge.backend).toBeInstanceOf(StubOmniVoiceBackend);
    expect(bridge.hasRealTtsBackend()).toBe(false);
  });

  it("prewarmIdlePhrases() is a no-op without a real backend (never caches zeros)", async () => {
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await bridge.arm();
    const result = await bridge.prewarmIdlePhrases();
    expect(result).toEqual({ warmed: 0, cached: 0 });
  });

  it("playFirstAudioFiller() is a no-op without a real backend", async () => {
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await bridge.arm();
    expect(bridge.playFirstAudioFiller()).toBeNull();
  });

  it("prewarmIdlePhrases() is a no-op when voice is not armed", async () => {
    const backend = new RecordingBackend();
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
    });
    // Not armed.
    const result = await bridge.prewarmIdlePhrases();
    expect(result).toEqual({ warmed: 0, cached: 0 });
    expect(backend.synthesized).toHaveLength(0);
  });

  it("prewarmIdlePhrases() synthesizes the seed list with a real backend", async () => {
    const backend = new RecordingBackend();
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    expect(bridge.hasRealTtsBackend()).toBe(true);
    await bridge.arm();
    const result = await bridge.prewarmIdlePhrases();
    expect(result.warmed).toBe(DEFAULT_PHRASE_CACHE_SEED.length);
    expect(result.cached).toBe(0);
    expect(new Set(backend.synthesized)).toEqual(
      new Set(DEFAULT_PHRASE_CACHE_SEED),
    );
    // A second pass is fully cached.
    const second = await bridge.prewarmIdlePhrases();
    expect(second.cached).toBe(DEFAULT_PHRASE_CACHE_SEED.length);
    expect(second.warmed).toBe(0);
  });

  it("playFirstAudioFiller() plays a cached filler once a real backend prewarmed it", async () => {
    const backend = new RecordingBackend();
    const bridge = EngineVoiceBridge.start({
      bundleRoot,
      useFfiBackend: false,
      backendOverride: backend,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await bridge.arm();
    // No filler cached yet.
    expect(bridge.playFirstAudioFiller()).toBeNull();
    await bridge.prewarmIdlePhrases();
    const played = bridge.playFirstAudioFiller();
    expect(played).not.toBeNull();
    expect(FIRST_AUDIO_FILLERS).toContain(played);
  });
});
