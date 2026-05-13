import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SpeakerPreset } from "./types";
import {
  readVoicePresetFile,
  type VoicePresetSeedPhrase,
} from "./voice-preset-format";

export interface PresetBundlePaths {
  bundleRoot: string;
  /** Relative path to the *default* voice preset inside the bundle. */
  cacheRelPath?: string;
}

export interface LoadedPresetBundle {
  preset: SpeakerPreset;
  /** Phrase-cache seed entries parsed alongside the embedding. The engine
   *  bridge feeds these into a `PhraseCache.seed(...)` call before the
   *  scheduler is constructed. */
  phrases: ReadonlyArray<VoicePresetSeedPhrase>;
}

export interface SpeakerPresetCacheOptions {
  /**
   * Maximum number of distinct voices held in RAM at once. Speaker presets
   * are KB-scale (an embedding vector + the seed-phrase PCM), so the default
   * is generous; the bound exists so a connector that switches voices per
   * speaker (e.g. a Discord room with many users) does not grow unbounded.
   * On insert past the bound the least-recently-used voice is evicted.
   */
  maxVoices?: number;
}

export const DEFAULT_VOICE_ID = "default";
const DEFAULT_MAX_VOICES = 16;

export const DEFAULT_VOICE_PRESET_REL_PATH = path.join(
  "cache",
  "voice-preset-default.bin",
);

/**
 * Resolve the on-disk path of a voice preset inside a bundle. The default
 * voice lives at `cache/voice-preset-default.bin`; additional voices ship as
 * `cache/voice-preset-<voiceId>.bin`. Throws on a `voiceId` that is not a safe
 * single path segment (no `/`, no `..`).
 */
export function voicePresetPath(bundleRoot: string, voiceId: string): string {
  if (voiceId === DEFAULT_VOICE_ID) {
    return path.join(bundleRoot, DEFAULT_VOICE_PRESET_REL_PATH);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(voiceId) || voiceId.includes("..")) {
    throw new Error(
      `[voice] Invalid voiceId ${JSON.stringify(voiceId)} — must be a single path-safe segment.`,
    );
  }
  return path.join(bundleRoot, "cache", `voice-preset-${voiceId}.bin`);
}

interface CacheEntry {
  preset: SpeakerPreset;
  phrases: ReadonlyArray<VoicePresetSeedPhrase>;
}

/**
 * LRU cache of parsed speaker presets keyed by `voiceId`. Holds the speaker
 * embedding, the raw preset bytes (for FFI handoff), and the phrase-cache seed
 * list parsed from the preset file. Multi-voice: `load(bundleRoot, voiceId)`
 * reads `cache/voice-preset-<voiceId>.bin` from the bundle on a miss.
 */
export class SpeakerPresetCache {
  // `Map` preserves insertion order; we re-insert on access so the first key
  // is always the least-recently-used.
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxVoices: number;

  constructor(opts: SpeakerPresetCacheOptions = {}) {
    this.maxVoices = Math.max(
      1,
      Math.floor(opts.maxVoices ?? DEFAULT_MAX_VOICES),
    );
  }

  /**
   * Load the bundle's default voice preset (`cache/voice-preset-default.bin`,
   * or `paths.cacheRelPath` if overridden) and return both the speaker
   * embedding and the phrase-cache seed entries. Cached for subsequent
   * `get("default")` lookups (and marked most-recently-used).
   */
  loadFromBundle(
    paths: PresetBundlePaths,
    voiceId = DEFAULT_VOICE_ID,
  ): LoadedPresetBundle {
    const rel =
      paths.cacheRelPath ??
      (voiceId === DEFAULT_VOICE_ID
        ? DEFAULT_VOICE_PRESET_REL_PATH
        : path.join("cache", `voice-preset-${voiceId}.bin`));
    return this.loadFile(path.join(paths.bundleRoot, rel), voiceId);
  }

  /**
   * Load an arbitrary voice by id from a bundle root, reading
   * `cache/voice-preset-<voiceId>.bin` (or `cache/voice-preset-default.bin`
   * for `"default"`). Returns the cached entry on a hit (marked MRU).
   */
  load(bundleRoot: string, voiceId: string): LoadedPresetBundle {
    return this.loadFile(voicePresetPath(bundleRoot, voiceId), voiceId);
  }

  /** True if `voiceId` is currently resident in the cache. */
  has(voiceId: string): boolean {
    return this.entries.has(voiceId);
  }

  put(preset: SpeakerPreset): void {
    const existing = this.entries.get(preset.voiceId);
    this.entries.delete(preset.voiceId);
    this.entries.set(preset.voiceId, {
      preset,
      phrases: existing?.phrases ?? [],
    });
    this.evictOverflow();
  }

  get(voiceId: string): SpeakerPreset | undefined {
    const entry = this.entries.get(voiceId);
    if (!entry) return undefined;
    this.entries.delete(voiceId);
    this.entries.set(voiceId, entry);
    return entry.preset;
  }

  /** Seed entries previously loaded for a voice, if any (does not touch LRU order). */
  getSeed(voiceId: string): ReadonlyArray<VoicePresetSeedPhrase> {
    return this.entries.get(voiceId)?.phrases ?? [];
  }

  /** Number of voices currently resident. */
  size(): number {
    return this.entries.size;
  }

  /** Drop every cached preset. */
  clear(): void {
    this.entries.clear();
  }

  private loadFile(fullPath: string, voiceId: string): LoadedPresetBundle {
    const cached = this.entries.get(voiceId);
    if (cached) {
      this.entries.delete(voiceId);
      this.entries.set(voiceId, cached);
      return { preset: cached.preset, phrases: cached.phrases };
    }
    if (!existsSync(fullPath)) {
      throw new Error(
        `[voice] Speaker preset for voice ${JSON.stringify(voiceId)} not found at ${fullPath}.`,
      );
    }
    const bytes = new Uint8Array(readFileSync(fullPath));
    const parsed = readVoicePresetFile(bytes);
    const preset: SpeakerPreset = {
      voiceId,
      embedding: parsed.embedding,
      bytes,
    };
    const entry: CacheEntry = { preset, phrases: parsed.phrases };
    this.entries.set(voiceId, entry);
    this.evictOverflow();
    return { preset, phrases: parsed.phrases };
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxVoices) {
      const lru = this.entries.keys().next().value;
      if (lru === undefined) return;
      this.entries.delete(lru);
    }
  }
}
