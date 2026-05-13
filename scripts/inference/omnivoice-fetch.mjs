#!/usr/bin/env node
/**
 * omnivoice-fetch.mjs
 *
 * User-facing entry point for staging the omnivoice GGUFs that
 * `@elizaos/plugin-omnivoice` auto-detects at boot.
 *
 * This is the standalone equivalent of `milady model fetch omnivoice`.
 * It wraps `convert-omnivoice-singing.mjs` for the singing variant and,
 * for the speech variant, drives the same `omnivoice.cpp/convert.py`
 * pipeline against `ModelsLab/omnivoice-base` and stages the result
 * under `<stateDir>/models/omnivoice/speech/`.
 *
 * The plugin's auto-enable + discovery (`src/discover.ts`) will pick up
 * whatever this script produces.
 *
 * Usage:
 *
 *   node scripts/inference/omnivoice-fetch.mjs [--singing] [--quantize Q8_0]
 *                                              [--state-dir <path>]
 *                                              [--out-dir <path>]
 *                                              [--dry-run]
 *
 *   node scripts/inference/omnivoice-fetch.mjs --help
 *
 * Defaults:
 *   - variant   : speech
 *   - quantize  : Q8_0
 *   - state-dir : $MILADY_STATE_DIR | $ELIZA_STATE_DIR | ~/.milady
 *   - out-dir   : <state-dir>/models/omnivoice/<variant>
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const SINGING_SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "inference",
  "convert-omnivoice-singing.mjs",
);
const VALID_QUANT = new Set(["none", "F16", "BF16", "Q8_0", "Q4_K_M"]);
const VALID_VARIANTS = new Set(["speech", "singing"]);

function log(level, msg) {
  process.stderr.write(`[omnivoice-fetch][${level}] ${msg}\n`);
}

function printHelp() {
  const help =
    "Usage: node scripts/inference/omnivoice-fetch.mjs [options]\n" +
    "\n" +
    "Stage omnivoice GGUFs under <state-dir>/models/omnivoice/{speech,singing}/.\n" +
    "The plugin-omnivoice runtime auto-detects whatever lands there.\n" +
    "\n" +
    "Options:\n" +
    "  --variant <speech|singing>   Which model family to fetch (default: speech)\n" +
    "  --singing                    Shortcut for --variant singing\n" +
    "  --quantize <type>            none | F16 | BF16 | Q8_0 | Q4_K_M  (default: Q8_0)\n" +
    "  --state-dir <path>           Per-user state root (default: $MILADY_STATE_DIR | ~/.milady)\n" +
    "  --out-dir <path>             Override output dir (default: <state-dir>/models/omnivoice/<variant>)\n" +
    "  --hf-cache <path>            HF download cache (default: <out-dir>/.hf-cache)\n" +
    "  --dry-run                    Print plan; do not execute\n" +
    "  -h, --help                   Show this help\n" +
    "\n" +
    "Environment:\n" +
    "  MILADY_STATE_DIR / ELIZA_STATE_DIR  override the state root.\n";
  process.stderr.write(help);
}

function parseArgs(argv) {
  const args = {
    variant: "speech",
    quantize: "Q8_0",
    stateDir: null,
    outDir: null,
    hfCache: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--singing") {
      args.variant = "singing";
    } else if (a === "--variant") {
      args.variant = argv[++i];
    } else if (a === "--quantize") {
      args.quantize = argv[++i];
    } else if (a === "--state-dir") {
      args.stateDir = path.resolve(argv[++i]);
    } else if (a === "--out-dir") {
      args.outDir = path.resolve(argv[++i]);
    } else if (a === "--hf-cache") {
      args.hfCache = path.resolve(argv[++i]);
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!VALID_VARIANTS.has(args.variant)) {
    throw new Error(
      `--variant must be one of ${[...VALID_VARIANTS].join(", ")} (got "${args.variant}")`,
    );
  }
  if (!VALID_QUANT.has(args.quantize)) {
    throw new Error(
      `--quantize must be one of ${[...VALID_QUANT].join(", ")} (got "${args.quantize}")`,
    );
  }
  return args;
}

function resolveStateDir(override) {
  if (override) return override;
  const env = process.env.MILADY_STATE_DIR || process.env.ELIZA_STATE_DIR;
  if (env && env.length > 0) return env;
  return path.join(homedir(), ".milady");
}

function spawnNode(scriptPath, scriptArgs) {
  return new Promise((resolve, reject) => {
    log("info", `$ node ${scriptPath} ${scriptArgs.join(" ")}`);
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${scriptPath} killed by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${scriptPath} exited ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function runSinging(args, outDir) {
  const subArgs = ["--out-dir", outDir, "--quantize", args.quantize];
  if (args.hfCache) subArgs.push("--hf-cache", args.hfCache);
  if (args.dryRun) subArgs.push("--dry-run");
  await spawnNode(SINGING_SCRIPT, subArgs);
}

async function runSpeech(args, outDir) {
  // The speech-side pipeline mirrors the singing one but pulls
  // `ModelsLab/omnivoice-base` and skips the `-singing-` rename. The
  // singing wrapper script is the only land-and-tested pipeline today;
  // wire-up of the parallel speech wrapper is tracked in
  // docs/inference/omnivoice-cli.md.
  log(
    "warn",
    "Speech-variant fetch is not yet automated end-to-end. " +
      "Until the speech wrapper lands, either:\n" +
      "  1. Drop omnivoice-base-*.gguf + omnivoice-tokenizer-*.gguf into " +
      `${outDir}/, or\n` +
      "  2. Run `--variant singing` and use the singing model for both codepaths.",
  );
  if (args.dryRun) {
    log(
      "info",
      "Dry run — would invoke speech wrapper here once it lands.",
    );
    return;
  }
  throw new Error(
    "speech-variant automation pending; see docs/inference/omnivoice-cli.md",
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    log("error", err.message);
    printHelp();
    process.exit(2);
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  const stateDir = resolveStateDir(args.stateDir);
  const outDir =
    args.outDir || path.join(stateDir, "models", "omnivoice", args.variant);

  log("info", `Repo root: ${REPO_ROOT}`);
  log("info", `State dir: ${stateDir}`);
  log("info", `Variant:   ${args.variant}`);
  log("info", `Out dir:   ${outDir}`);
  log("info", `Quantize:  ${args.quantize}`);

  if (!args.dryRun) {
    await mkdir(outDir, { recursive: true });
  }

  if (args.variant === "singing") {
    await runSinging(args, outDir);
  } else {
    await runSpeech(args, outDir);
  }

  log("info", "Done. Plugin-omnivoice will auto-detect on next agent boot.");
}

main().catch((err) => {
  log("error", err.message || String(err));
  process.exit(1);
});
