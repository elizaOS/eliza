/**
 * On-disk discovery for the Kokoro-only voice mode. Probes
 * `~/.eliza/local-inference/models/kokoro/` (or `$ELIZA_KOKORO_MODEL_DIR`)
 * for an ONNX file + at least one voice `.bin` under `voices/`. Returns
 * null when anything is missing — no auto-download (AGENTS.md §3).
 *
 * Env overrides:
 *   ELIZA_KOKORO_MODEL_DIR        — directory root
 *   ELIZA_KOKORO_MODEL_FILE       — ONNX filename inside the root
 *   ELIZA_KOKORO_DEFAULT_VOICE_ID — default voice id (e.g. `af_bella`)
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { KOKORO_DEFAULT_VOICE_ID, KOKORO_VOICE_PACKS } from "./voice-presets";
import type { KokoroModelLayout, KokoroVoicePack } from "./types";

/** Canonical Kokoro v1.0 output sample rate. */
export const KOKORO_DEFAULT_SAMPLE_RATE = 24_000;

/** Filenames the loader will accept if `ELIZA_KOKORO_MODEL_FILE` is unset. */
const CANDIDATE_MODEL_FILES: ReadonlyArray<string> = [
  "kokoro-v1.0.onnx",
  "kokoro-v1.0.int8.onnx",
  "model.onnx",
  "model_quantized.onnx",
];

export interface KokoroEngineDiscoveryResult {
  layout: KokoroModelLayout;
  /**
   * Resolved default voice id. Falls back to `KOKORO_DEFAULT_VOICE_ID`
   * when the env override is unset and `af_bella.bin` is on disk; otherwise
   * picks the first voice pack whose `.bin` is actually staged.
   */
  defaultVoiceId: string;
}

/** Returns the on-disk directory the discovery probes. */
export function kokoroEngineModelDir(): string {
  const env = process.env.ELIZA_KOKORO_MODEL_DIR?.trim();
  if (env) return env;
  return path.join(
    os.homedir(),
    ".eliza",
    "local-inference",
    "models",
    "kokoro",
  );
}

/**
 * Probe disk for a usable Kokoro layout. Returns null when any required
 * piece is missing — the engine then falls back to its existing behaviour
 * (fused omnivoice or `StubOmniVoiceBackend`).
 */
export function resolveKokoroEngineConfig(): KokoroEngineDiscoveryResult | null {
  const root = kokoroEngineModelDir();
  if (!existsSync(root)) return null;

  const modelFile = resolveModelFile(root);
  if (!modelFile) return null;

  const voicesDir = path.join(root, "voices");
  if (!existsSync(voicesDir)) return null;

  const defaultVoiceId = resolveDefaultVoiceId(voicesDir);
  if (!defaultVoiceId) return null;

  return {
    layout: {
      root,
      modelFile,
      voicesDir,
      sampleRate: KOKORO_DEFAULT_SAMPLE_RATE,
    },
    defaultVoiceId,
  };
}

function resolveModelFile(root: string): string | null {
  const env = process.env.ELIZA_KOKORO_MODEL_FILE?.trim();
  if (env) {
    return existsSync(path.join(root, env)) ? env : null;
  }
  for (const candidate of CANDIDATE_MODEL_FILES) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

function resolveDefaultVoiceId(voicesDir: string): string | null {
  const env = process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID?.trim();
  if (env) {
    const pack = findVoicePack(env);
    if (pack && existsSync(path.join(voicesDir, pack.file))) return pack.id;
    return null;
  }
  // Prefer the catalog default when its file is staged.
  const defaultPack = findVoicePack(KOKORO_DEFAULT_VOICE_ID);
  if (defaultPack && existsSync(path.join(voicesDir, defaultPack.file))) {
    return defaultPack.id;
  }
  // Otherwise pick the first catalog voice whose file is on disk. This
  // lets operators stage a single voice (any voice) and have it just work.
  const staged = listStagedVoiceIds(voicesDir);
  return staged[0] ?? null;
}

function findVoicePack(id: string): KokoroVoicePack | null {
  return KOKORO_VOICE_PACKS.find((v) => v.id === id) ?? null;
}

function listStagedVoiceIds(voicesDir: string): string[] {
  try {
    const present = new Set(readdirSync(voicesDir));
    return KOKORO_VOICE_PACKS.filter((v) => present.has(v.file)).map(
      (v) => v.id,
    );
  } catch {
    return [];
  }
}
