/**
 * Filesystem-based discovery for omnivoice GGUFs.
 *
 * Convention: per-user state dir (`MILADY_STATE_DIR` / `ELIZA_STATE_DIR` /
 * `~/.milady`) holds the converted artifacts at:
 *
 *   <stateDir>/models/omnivoice/speech/{base,model}*.gguf  (LM)
 *   <stateDir>/models/omnivoice/speech/{tokenizer,codec}*.gguf  (codec)
 *   <stateDir>/models/omnivoice/singing/{base,model}*.gguf
 *   <stateDir>/models/omnivoice/singing/{tokenizer,codec}*.gguf
 *
 * `discoverOmnivoiceModels()` performs sync, network-free filesystem reads
 * and returns the paths the runtime can plug into `loadSettings()` as a
 * fallback when neither env nor runtime.getSetting() supplied them.
 *
 * Heuristics — name-based, case-insensitive:
 *   - filename contains "tokenizer" or "codec" -> codec path
 *   - filename contains "base" or "model" (and not "tokenizer/codec") -> LM
 *   - extension must be `.gguf`
 *
 * If a directory exists but contains malformed filenames (no clear match
 * for either role), a warning is logged and `null` is returned for that
 * variant so the auto-enable check stays conservative.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { logger } from "@elizaos/core";

export interface OmnivoiceModelPair {
  modelPath: string;
  codecPath: string;
}

export interface OmnivoiceDiscoveryResult {
  speech: OmnivoiceModelPair | null;
  singing: OmnivoiceModelPair | null;
}

export interface OmnivoiceDiscoveryOptions {
  /** Override the per-user state root. Defaults to env / ~/.milady. */
  stateDir?: string;
}

function resolveStateDir(stateDir: string | undefined): string {
  if (stateDir && stateDir.length > 0) return stateDir;
  const env =
    process.env.MILADY_STATE_DIR ??
    process.env.ELIZA_STATE_DIR ??
    undefined;
  if (env && env.length > 0) return env;
  return join(homedir(), ".milady");
}

function isGgufFile(name: string): boolean {
  return name.toLowerCase().endsWith(".gguf");
}

function classify(name: string): "codec" | "model" | null {
  const lower = name.toLowerCase();
  if (lower.includes("tokenizer") || lower.includes("codec")) return "codec";
  if (lower.includes("base") || lower.includes("model")) return "model";
  return null;
}

function scanVariantDir(
  dir: string,
  variant: "speech" | "singing",
): OmnivoiceModelPair | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return null;
    entries = readdirSync(dir);
  } catch (err) {
    logger.warn(
      `[plugin-omnivoice] discover: cannot read ${dir}: ${(err as Error).message}`,
    );
    return null;
  }

  const ggufs = entries.filter(isGgufFile);
  if (ggufs.length === 0) return null;

  let modelName: string | null = null;
  let codecName: string | null = null;
  const unclassified: string[] = [];

  // Prefer quantized (non-F32) builds for the LM, but accept whatever
  // the user has. Sorting ascending puts F32 first; reverse so Q8_0 /
  // Q4_K_M / BF16 win the tie when both exist.
  for (const name of [...ggufs].sort().reverse()) {
    const role = classify(name);
    if (role === "model" && !modelName) modelName = name;
    else if (role === "codec" && !codecName) codecName = name;
    else if (role === null) unclassified.push(name);
  }

  if (!modelName || !codecName) {
    if (unclassified.length > 0) {
      logger.warn(
        `[plugin-omnivoice] discover: ${variant} dir ${dir} has unrecognized GGUF names (${unclassified.join(", ")}); set OMNIVOICE_MODEL_PATH / OMNIVOICE_CODEC_PATH explicitly`,
      );
    }
    return null;
  }

  return {
    modelPath: join(dir, modelName),
    codecPath: join(dir, codecName),
  };
}

/**
 * Discover omnivoice speech + singing GGUF pairs under the per-user
 * state directory. Sync, network-free.
 */
export function discoverOmnivoiceModels(
  options: OmnivoiceDiscoveryOptions = {},
): OmnivoiceDiscoveryResult {
  const root = resolveStateDir(options.stateDir);
  const baseDir = join(root, "models", "omnivoice");
  return {
    speech: scanVariantDir(join(baseDir, "speech"), "speech"),
    singing: scanVariantDir(join(baseDir, "singing"), "singing"),
  };
}
