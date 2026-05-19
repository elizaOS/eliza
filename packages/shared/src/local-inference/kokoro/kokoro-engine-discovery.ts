/**
 * On-disk discovery for the Kokoro-only voice mode. Probes
 * `~/.eliza/local-inference/models/kokoro/` (or `$ELIZA_KOKORO_MODEL_DIR`)
 * for a GGUF model file plus at least one voice `.bin` under `voices/`.
 * Callers can pass an explicit model root to probe bundle-local Kokoro
 * artifacts first. Returns null when anything is missing — no auto-download
 * (AGENTS.md §3).
 *
 * Env overrides:
 *   ELIZA_KOKORO_MODEL_DIR        — directory root
 *   ELIZA_KOKORO_MODEL_FILE       — exact filename inside the root (GGUF)
 *   ELIZA_KOKORO_DEFAULT_VOICE_ID — default voice id (e.g. `af_same`, `af_bella`)
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { elizaModelsDir } from "../paths.js";
import type { KokoroModelLayout, KokoroVoicePack } from "./types.js";
import {
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_FALLBACK_VOICE_ID,
  KOKORO_VOICE_PACKS,
} from "./voice-presets.js";

/** Canonical Kokoro v1.0 output sample rate. */
export const KOKORO_DEFAULT_SAMPLE_RATE = 24_000;

/**
 * Filenames the loader will accept if `ELIZA_KOKORO_MODEL_FILE` is unset.
 * Order is preference-first: Q4_K_M GGUF (quantized, shipping tier) before
 * the unquantized GGUF.
 */
const CANDIDATE_MODEL_FILES: ReadonlyArray<string> = [
  "kokoro-82m-v1_0-Q4_K_M.gguf",
  "kokoro-82m-v1_0.gguf",
];

/** True iff the candidate filename routes to the fused GGUF path. */
export function isKokoroGgufFile(filename: string): boolean {
  return /\.gguf$/i.test(filename);
}

export interface KokoroEngineDiscoveryResult {
  layout: KokoroModelLayout;
  /**
   * Resolved default voice id. Resolution order:
   *   1. `ELIZA_KOKORO_DEFAULT_VOICE_ID` env override (if its `.bin` is staged)
   *   2. `KOKORO_DEFAULT_VOICE_ID` (Samantha / `af_same`) when its preset is
   *      on disk — the canonical Eliza-1 voice
   *   3. Loud fallback to `KOKORO_FALLBACK_VOICE_ID` (`af_bella`) with a
   *      console warning so operators see the degradation; this fires while
   *      the samantha LoRA pipeline has not yet produced a real `af_same.bin`
   *   4. First voice pack whose `.bin` is actually staged (last resort —
   *      lets a single arbitrary voice work for unusual install layouts)
   */
  defaultVoiceId: string;
  /** Always `"gguf"` — only GGUF model files are accepted. */
  runtimeKind: "gguf" | "onnx";
}

/** Returns the on-disk directory the discovery probes. */
export function kokoroEngineModelDir(rootOverride?: string): string {
  const explicit = rootOverride?.trim();
  if (explicit) return explicit;
  const env = process.env.ELIZA_KOKORO_MODEL_DIR?.trim();
  if (env) return env;
  return path.join(elizaModelsDir(), "kokoro");
}

/**
 * Probe disk for a usable Kokoro layout. Returns null when any required
 * piece is missing — the engine then falls back to its existing behaviour
 * (fused omnivoice or `StubOmniVoiceBackend`).
 */
export function resolveKokoroEngineConfig(
  rootOverride?: string,
): KokoroEngineDiscoveryResult | null {
  const root = kokoroEngineModelDir(rootOverride);
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
    runtimeKind: "gguf",
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
  // Prefer the canonical Eliza-1 default (Samantha) when its file is staged.
  const defaultPack = findVoicePack(KOKORO_DEFAULT_VOICE_ID);
  if (defaultPack && existsSync(path.join(voicesDir, defaultPack.file))) {
    return defaultPack.id;
  }
  // Loud fallback to the bundled upstream voice (af_bella). This MUST be
  // visible because the canonical default is Samantha; we only land here
  // when the LoRA pipeline has not produced a real `af_same.bin`. Operators
  // should see this and run the samantha LoRA RUNBOOK or the
  // regenerate-samantha-preset.mjs script.
  const fallbackPack = findVoicePack(KOKORO_FALLBACK_VOICE_ID);
  if (fallbackPack && existsSync(path.join(voicesDir, fallbackPack.file))) {
    console.warn(
      `[kokoro] default voice ${KOKORO_DEFAULT_VOICE_ID} preset not staged at ${path.join(voicesDir, defaultPack?.file ?? `${KOKORO_DEFAULT_VOICE_ID}.bin`)} — falling back to ${KOKORO_FALLBACK_VOICE_ID}. Run packages/training/scripts/voice/samantha_lora/RUNBOOK.md to produce a real Samantha preset, or regenerate via plugins/plugin-local-inference/scripts/regenerate-samantha-preset.mjs.`,
    );
    return fallbackPack.id;
  }
  // Last resort: pick the first catalog voice whose file is on disk. This
  // covers unusual install layouts where neither samantha nor af_bella is
  // present but some other voice is.
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
