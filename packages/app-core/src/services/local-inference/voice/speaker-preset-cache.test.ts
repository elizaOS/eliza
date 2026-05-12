import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_PRESET_REL_PATH,
  SpeakerPresetCache,
  voicePresetPath,
} from "./speaker-preset-cache";
import { writeVoicePresetFile } from "./voice-preset-format";

function presetBlob(seedScalar: number): Uint8Array {
  return writeVoicePresetFile({
    embedding: new Float32Array([seedScalar, seedScalar + 1, seedScalar + 2]),
    phrases: [
      {
        text: `phrase-${seedScalar}`,
        sampleRate: 24000,
        pcm: new Float32Array([seedScalar / 10, -seedScalar / 10]),
      },
    ],
  });
}

describe("voicePresetPath", () => {
  it("maps the default voice to the canonical relative path", () => {
    expect(voicePresetPath("/bundle", DEFAULT_VOICE_ID)).toBe(
      path.join("/bundle", DEFAULT_VOICE_PRESET_REL_PATH),
    );
  });

  it("maps named voices to cache/voice-preset-<id>.bin", () => {
    expect(voicePresetPath("/bundle", "narrator")).toBe(
      path.join("/bundle", "cache", "voice-preset-narrator.bin"),
    );
  });

  it("rejects unsafe voice ids", () => {
    expect(() => voicePresetPath("/bundle", "../escape")).toThrow();
    expect(() => voicePresetPath("/bundle", "a/b")).toThrow();
    expect(() => voicePresetPath("/bundle", "")).toThrow();
  });
});

describe("SpeakerPresetCache", () => {
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-preset-cache-"));
    mkdirSync(path.join(bundleRoot, "cache"), { recursive: true });
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  function writeVoiceFile(voiceId: string, scalar: number): void {
    writeFileSync(voicePresetPath(bundleRoot, voiceId), presetBlob(scalar));
  }

  it("loads the default preset from a bundle and exposes embedding + seed phrases", () => {
    writeVoiceFile(DEFAULT_VOICE_ID, 1);
    const cache = new SpeakerPresetCache();
    const { preset, phrases } = cache.loadFromBundle({ bundleRoot });
    expect(preset.voiceId).toBe(DEFAULT_VOICE_ID);
    expect(Array.from(preset.embedding)).toEqual([1, 2, 3]);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe("phrase-1");
    expect(cache.has(DEFAULT_VOICE_ID)).toBe(true);
    expect(cache.get(DEFAULT_VOICE_ID)?.embedding[0]).toBe(1);
    expect(cache.getSeed(DEFAULT_VOICE_ID)).toHaveLength(1);
  });

  it("returns the cached entry on a second load (no re-parse)", () => {
    writeVoiceFile(DEFAULT_VOICE_ID, 5);
    const cache = new SpeakerPresetCache();
    const first = cache.loadFromBundle({ bundleRoot }).preset;
    const second = cache.loadFromBundle({ bundleRoot }).preset;
    expect(second).toBe(first);
  });

  it("loads arbitrary named voices via load(bundleRoot, voiceId)", () => {
    writeVoiceFile("narrator", 7);
    writeVoiceFile("whisper", 9);
    const cache = new SpeakerPresetCache();
    const narrator = cache.load(bundleRoot, "narrator");
    const whisper = cache.load(bundleRoot, "whisper");
    expect(narrator.preset.voiceId).toBe("narrator");
    expect(Array.from(narrator.preset.embedding)).toEqual([7, 8, 9]);
    expect(whisper.preset.voiceId).toBe("whisper");
    expect(Array.from(whisper.preset.embedding)).toEqual([9, 10, 11]);
    expect(cache.size()).toBe(2);
  });

  it("throws a clear error when the preset file is missing", () => {
    const cache = new SpeakerPresetCache();
    expect(() => cache.load(bundleRoot, "missing")).toThrow(/not found/);
  });

  it("evicts the least-recently-used voice past maxVoices", () => {
    writeVoiceFile("a", 1);
    writeVoiceFile("b", 2);
    writeVoiceFile("c", 3);
    const cache = new SpeakerPresetCache({ maxVoices: 2 });
    cache.load(bundleRoot, "a");
    cache.load(bundleRoot, "b");
    expect(cache.size()).toBe(2);
    // Touch "a" so "b" becomes LRU.
    expect(cache.get("a")).toBeDefined();
    cache.load(bundleRoot, "c");
    expect(cache.size()).toBe(2);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("re-loading an evicted voice re-parses from disk", () => {
    writeVoiceFile("a", 1);
    writeVoiceFile("b", 2);
    const cache = new SpeakerPresetCache({ maxVoices: 1 });
    const a1 = cache.load(bundleRoot, "a").preset;
    cache.load(bundleRoot, "b");
    expect(cache.has("a")).toBe(false);
    const a2 = cache.load(bundleRoot, "a").preset;
    expect(a2).not.toBe(a1);
    expect(Array.from(a2.embedding)).toEqual([1, 2, 3]);
  });

  it("put() inserts a preset and preserves any previously-loaded seed", () => {
    writeVoiceFile(DEFAULT_VOICE_ID, 4);
    const cache = new SpeakerPresetCache();
    cache.loadFromBundle({ bundleRoot });
    expect(cache.getSeed(DEFAULT_VOICE_ID)).toHaveLength(1);
    cache.put({
      voiceId: DEFAULT_VOICE_ID,
      embedding: new Float32Array([0]),
      bytes: new Uint8Array(0),
    });
    expect(cache.get(DEFAULT_VOICE_ID)?.embedding[0]).toBe(0);
    // Seed survives the embedding replacement.
    expect(cache.getSeed(DEFAULT_VOICE_ID)).toHaveLength(1);
  });

  it("clear() drops all entries", () => {
    writeVoiceFile("a", 1);
    const cache = new SpeakerPresetCache();
    cache.load(bundleRoot, "a");
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has("a")).toBe(false);
  });
});
