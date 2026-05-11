import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpeakerPreset } from "./types";
import {
  readVoicePresetFile,
  type VoicePresetSeedPhrase,
} from "./voice-preset-format";

export interface PresetBundlePaths {
  bundleRoot: string;
  cacheRelPath?: string;
}

export interface LoadedPresetBundle {
  preset: SpeakerPreset;
  /** Phrase-cache seed entries parsed alongside the embedding. The engine
   *  bridge feeds these into a `PhraseCache.seed(...)` call before the
   *  scheduler is constructed. */
  phrases: ReadonlyArray<VoicePresetSeedPhrase>;
}

const DEFAULT_REL_PATH = path.join("cache", "voice-preset-default.bin");

export class SpeakerPresetCache {
  private readonly cache = new Map<string, SpeakerPreset>();
  private readonly seeds = new Map<
    string,
    ReadonlyArray<VoicePresetSeedPhrase>
  >();

  /**
   * Load a voice-preset binary file and return both the speaker embedding
   * and the phrase-cache seed entries. The embedding is also cached for
   * subsequent `get()` lookups.
   */
  loadFromBundle(
    paths: PresetBundlePaths,
    voiceId = "default",
  ): LoadedPresetBundle {
    const cached = this.cache.get(voiceId);
    if (cached) {
      return {
        preset: cached,
        phrases: this.seeds.get(voiceId) ?? [],
      };
    }

    const rel = paths.cacheRelPath ?? DEFAULT_REL_PATH;
    const fullPath = path.join(paths.bundleRoot, rel);
    const bytes = readFileSync(fullPath);
    const parsed = readVoicePresetFile(new Uint8Array(bytes));
    const preset: SpeakerPreset = {
      voiceId,
      embedding: parsed.embedding,
      bytes: new Uint8Array(bytes),
    };
    this.cache.set(voiceId, preset);
    this.seeds.set(voiceId, parsed.phrases);
    return { preset, phrases: parsed.phrases };
  }

  put(preset: SpeakerPreset): void {
    this.cache.set(preset.voiceId, preset);
  }

  get(voiceId: string): SpeakerPreset | undefined {
    return this.cache.get(voiceId);
  }

  /** Seed entries previously loaded for a voice, if any. */
  getSeed(voiceId: string): ReadonlyArray<VoicePresetSeedPhrase> {
    return this.seeds.get(voiceId) ?? [];
  }
}
