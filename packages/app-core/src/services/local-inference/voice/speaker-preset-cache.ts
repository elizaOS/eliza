import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpeakerPreset } from "./types";

export interface PresetBundlePaths {
  bundleRoot: string;
  cacheRelPath?: string;
}

const DEFAULT_REL_PATH = path.join("cache", "voice-preset-default.bin");

export class SpeakerPresetCache {
  private readonly cache = new Map<string, SpeakerPreset>();

  loadFromBundle(paths: PresetBundlePaths, voiceId = "default"): SpeakerPreset {
    const cached = this.cache.get(voiceId);
    if (cached) return cached;

    const rel = paths.cacheRelPath ?? DEFAULT_REL_PATH;
    const fullPath = path.join(paths.bundleRoot, rel);
    const bytes = readFileSync(fullPath);
    const preset = this.parseBytes(voiceId, bytes);
    this.cache.set(voiceId, preset);
    return preset;
  }

  put(preset: SpeakerPreset): void {
    this.cache.set(preset.voiceId, preset);
  }

  get(voiceId: string): SpeakerPreset | undefined {
    return this.cache.get(voiceId);
  }

  private parseBytes(voiceId: string, bytes: Uint8Array): SpeakerPreset {
    const aligned = bytes.byteLength - (bytes.byteLength % 4);
    const view = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      aligned / 4,
    );
    const embedding = new Float32Array(view);
    return { voiceId, embedding, bytes: new Uint8Array(bytes) };
  }
}
