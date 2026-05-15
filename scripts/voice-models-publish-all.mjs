#!/usr/bin/env node
/**
 * voice-models-publish-all.mjs
 *
 * Publishes all 10 eliza-1 voice sub-model repos to HuggingFace.
 *
 * Usage:
 *   bun run voice-models:publish-all              # publish all
 *   bun run voice-models:publish-all -- --dry-run # print commands only
 *   bun run voice-models:publish-all -- --model asr  # publish one model
 *
 * Prerequisites:
 *   - HF_TOKEN env var must be set (huggingface-cli login or env)
 *   - huggingface-cli must be installed: pip install huggingface_hub[cli]
 *   - staging dirs must exist under artifacts/voice-sub-model-staging/<id>/
 *
 * Each repo is created if absent, then the staging dir is uploaded.
 * Re-runs are idempotent: upload overwrites files with the same path.
 *
 * Coordination:
 *   - F2 (kokoro): publishes retrained weights to elizaos/eliza-1-voice-kokoro
 *     when quality gates pass. This script uploads the base/preset files.
 *   - F5 (mmproj): publishes mmproj files to elizaos/eliza-1 (main bundle repo),
 *     not to any sub-model repo here.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STAGING_BASE = join(REPO_ROOT, "artifacts", "voice-sub-model-staging");

// Canonical sub-model repo manifest per F3 brief (W3-12 namespace correction).
// id: local staging dir name
// repo: HF repo slug
// description: human summary for logging
const VOICE_MODELS = [
  {
    id: "asr",
    repo: "elizaos/eliza-1-voice-asr",
    description: "Qwen3-ASR GGUF + mmproj",
  },
  {
    id: "turn",
    repo: "elizaos/eliza-1-voice-turn",
    description: "LiveKit turn-detector (EN + INTL) + turnsense fallback",
  },
  {
    id: "emotion",
    repo: "elizaos/eliza-1-voice-emotion",
    description: "Wav2Small V-A-D emotion classifier (distilled)",
  },
  {
    id: "speaker",
    repo: "elizaos/eliza-1-voice-speaker",
    description: "WeSpeaker ECAPA-TDNN 256-dim speaker encoder",
  },
  {
    id: "diarizer",
    repo: "elizaos/eliza-1-voice-diarizer",
    description: "Pyannote-segmentation-3.0 ONNX diarizer",
  },
  {
    id: "vad",
    repo: "elizaos/eliza-1-voice-vad",
    description: "Silero VAD v5.1.2",
  },
  {
    id: "wakeword",
    repo: "elizaos/eliza-1-voice-wakeword",
    description: "hey-eliza wake-word head",
  },
  {
    id: "kokoro",
    repo: "elizaos/eliza-1-voice-kokoro",
    description: "Kokoro-82M base + sam preset (F2 coordination)",
  },
  {
    id: "omnivoice",
    repo: "elizaos/eliza-1-voice-omnivoice",
    description: "OmniVoice frozen conditioning + sam ELZ2 v2 preset",
  },
  {
    id: "embedding",
    repo: "elizaos/eliza-1-voice-embedding",
    description: "Qwen3-Embedding GGUF for voice profile text features",
  },
];

// Parse CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const modelFilter = (() => {
  const idx = args.indexOf("--model");
  return idx !== -1 ? args[idx + 1] : null;
})();

/**
 * Run a command, logging it first.
 * In dry-run mode, only logs the command.
 */
function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  if (isDryRun) return { status: 0 };
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", ...opts });
  return result;
}

/**
 * Check that huggingface-cli is installed and HF_TOKEN is set.
 */
function checkPrerequisites() {
  const errors = [];

  if (!process.env.HF_TOKEN) {
    errors.push(
      "HF_TOKEN env var is not set. Set it with: export HF_TOKEN=hf_...",
    );
  }

  const hfCli = spawnSync("huggingface-cli", ["--version"], {
    shell: true,
    encoding: "utf-8",
  });
  if (hfCli.status !== 0) {
    errors.push(
      "huggingface-cli not found. Install with: pip install huggingface_hub[cli]",
    );
  }

  return errors;
}

/**
 * Publish one voice sub-model repo.
 * Returns { success: boolean, skipped: boolean, reason?: string }
 */
function publishModel(model) {
  const stagingDir = join(STAGING_BASE, model.id);

  if (!existsSync(stagingDir)) {
    return {
      success: false,
      skipped: true,
      reason: `Staging dir not found: ${stagingDir}`,
    };
  }

  console.log(`\n--- ${model.repo} ---`);
  console.log(`    ${model.description}`);
  console.log(`    Staging: ${stagingDir}`);

  // Step 1: Create the repo (idempotent — fails silently if exists)
  console.log("\n  [1/2] Create HF repo (idempotent)");
  const createResult = run(
    `huggingface-cli repo create ${model.repo} --type model --yes`,
  );
  if (!isDryRun && createResult.status !== 0) {
    // Repo may already exist — not fatal. Log and continue.
    console.log(
      `  (repo may already exist — continuing with upload regardless)`,
    );
  }

  // Step 2: Upload staging dir contents
  console.log("\n  [2/2] Upload staging dir");
  const uploadResult = run(
    `huggingface-cli upload ${model.repo} ${stagingDir} .`,
  );

  if (!isDryRun && uploadResult.status !== 0) {
    return {
      success: false,
      skipped: false,
      reason: `huggingface-cli upload exited with status ${uploadResult.status}`,
    };
  }

  return { success: true, skipped: false };
}

// Main
async function main() {
  console.log("=== eliza-1 voice sub-model publish-all ===");
  if (isDryRun) console.log("DRY RUN — no commands will execute\n");

  // Prerequisites
  const errors = checkPrerequisites();
  if (errors.length > 0 && !isDryRun) {
    console.error("\nPrerequisite check failed:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nStaging dirs are ready; re-run with HF_TOKEN set to publish.",
    );
    process.exit(1);
  } else if (errors.length > 0 && isDryRun) {
    console.warn("\nWould fail prerequisites (dry-run continues anyway):");
    for (const e of errors) console.warn(`  - ${e}`);
    console.warn();
  }

  const models = modelFilter
    ? VOICE_MODELS.filter((m) => m.id === modelFilter)
    : VOICE_MODELS;

  if (modelFilter && models.length === 0) {
    console.error(`Unknown model id: ${modelFilter}`);
    console.error(
      `Available ids: ${VOICE_MODELS.map((m) => m.id).join(", ")}`,
    );
    process.exit(1);
  }

  const results = [];
  for (const model of models) {
    const result = publishModel(model);
    results.push({ ...result, model });
  }

  // Summary
  console.log("\n=== Summary ===");
  let allOk = true;
  for (const r of results) {
    const status = r.skipped
      ? "SKIP"
      : r.success
        ? isDryRun
          ? "DRY"
          : "OK  "
        : "FAIL";
    const note = r.reason ? ` — ${r.reason}` : "";
    console.log(`  [${status}] ${r.model.repo}${note}`);
    if (!r.success && !r.skipped) allOk = false;
  }

  if (!allOk) {
    console.error("\nSome repos failed to publish. See output above.");
    process.exit(1);
  } else {
    console.log(
      isDryRun ? "\nDry run complete." : "\nAll repos published successfully.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
