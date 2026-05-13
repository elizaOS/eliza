#!/usr/bin/env node
/**
 * Compatibility entry point for local voice E2E evaluation.
 *
 * This script used to synthesize with a local TTS binary and score with
 * OpenAI Whisper. That is no longer a valid Eliza-1 E2E signal: ASR must
 * come from the local fused Eliza-1 bundle, and missing artifacts must fail
 * clearly. The real runner lives at
 * `packages/app-core/scripts/voice-e2e-hardware.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const runner = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "voice-e2e-hardware.ts",
);

function translateArgs(argv) {
  const pass = [];
  let id = "eliza-local-voice-e2e";
  let outputDir = "";
  let hasOut = false;
  let hasAudioDir = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} requires a value`);
      return argv[i];
    };
    if (a === "--id") {
      id = next();
    } else if (a === "--output-dir") {
      outputDir = next();
    } else if (a === "--seed" || a === "--duration" || a === "--instruct") {
      next();
    } else if (a === "--no-denoise") {
      // The fused Eliza-1 FFI runner does not expose the legacy denoise flag.
    } else {
      if (a === "--out" || a === "--report") hasOut = true;
      if (a === "--audio-dir") hasAudioDir = true;
      pass.push(a);
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        pass.push(argv[++i]);
      }
    }
  }

  if (outputDir) {
    const abs = path.resolve(outputDir);
    if (!hasOut) pass.push("--out", path.join(abs, `${id}.report.json`));
    if (!hasAudioDir) pass.push("--audio-dir", abs);
  }
  return pass;
}

let translated;
try {
  translated = translateArgs(process.argv.slice(2));
} catch (err) {
  console.error(
    `[local-voice-loop-eval] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const localBun = path.join(repoRoot, "node_modules", ".bin", "bun");
const bun = process.env.BUN || (existsSync(localBun) ? localBun : "bun");
const result = spawnSync(bun, [runner, ...translated], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(
    `[local-voice-loop-eval] failed to start ${bun}: ${result.error.message}`,
  );
  process.exit(1);
}

process.exit(result.status ?? (result.signal ? 1 : 0));
