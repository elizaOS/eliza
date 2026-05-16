#!/usr/bin/env node
/**
 * voice-models-publish-all.mjs
 *
 * Publishes all 10 eliza-1 voice sub-model payloads to HuggingFace.
 *
 * Usage:
 *   bun run voice-models:publish-all              # publish all
 *   bun run voice-models:publish-all -- --dry-run # print commands only
 *   bun run voice-models:publish-all -- --model asr  # publish one model
 *
 * Prerequisites:
 *   - HF auth must be configured (`hf auth login`) or HF_TOKEN must be set.
 *   - hf CLI must be installed: pip install huggingface_hub[cli]
 *   - staging dirs must exist under artifacts/voice-sub-model-staging/<id>/
 *
 * The single canonical repo is created if absent, then each staging dir is
 * uploaded under voice/<id>/.
 * Re-runs are idempotent: upload overwrites files with the same path.
 *
 * Coordination:
 *   - The split `elizalabs/eliza-1-voice-*` repos have been deleted as of
 *     2026-05-15; the unified `elizalabs/eliza-1` repo is the only target.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STAGING_BASE = join(REPO_ROOT, "artifacts", "voice-sub-model-staging");
const TARGET_REPO = process.env.ELIZA_1_HF_REPO ?? "elizalabs/eliza-1";

// Canonical voice payload manifest.
// id: local staging dir name
// path: path prefix inside TARGET_REPO
// description: human summary for logging
const VOICE_MODELS = [
  {
    id: "asr",
    path: "voice/asr",
    description: "Qwen3-ASR GGUF + mmproj",
  },
  {
    id: "turn",
    path: "voice/turn-detector",
    description: "LiveKit turn-detector (EN + INTL) + turnsense fallback",
  },
  {
    id: "emotion",
    path: "voice/voice-emotion",
    description: "Wav2Small V-A-D emotion classifier (distilled)",
  },
  {
    id: "speaker",
    path: "voice/speaker-encoder",
    description: "WeSpeaker ECAPA-TDNN 256-dim speaker encoder",
  },
  {
    id: "diarizer",
    path: "voice/diarizer",
    description: "Pyannote-segmentation-3.0 ONNX diarizer",
  },
  {
    id: "vad",
    path: "voice/vad",
    description: "Silero VAD v5 GGUF",
    requiredFiles: ["silero-vad-v5.gguf"],
  },
  {
    id: "wakeword",
    path: "voice/wakeword",
    description: "hey-eliza wake-word head",
  },
  {
    id: "kokoro",
    path: "voice/kokoro",
    description: "Kokoro-82M base + same-voice preset (F2 coordination)",
  },
  {
    id: "omnivoice",
    path: "voice/omnivoice",
    description: "OmniVoice frozen conditioning + same-voice ELZ2 v2 preset",
  },
  {
    id: "embedding",
    path: "voice/embedding",
    description: "Qwen3-Embedding GGUF for voice profile text features",
  },
];

// Parse CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const onlyWithBinaries = args.includes("--only-with-binaries");
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
 * Check that hf CLI is installed and auth is configured.
 */
function checkPrerequisites() {
  const errors = [];

  const hfWhoami = spawnSync("hf", ["auth", "whoami"], {
    shell: true,
    encoding: "utf-8",
  });
  if (!process.env.HF_TOKEN && hfWhoami.status !== 0) {
    errors.push(
      "HF auth is not configured. Run `hf auth login` or set HF_TOKEN.",
    );
  }

  const hfCli = spawnSync("hf", ["version"], {
    shell: true,
    encoding: "utf-8",
  });
  if (hfCli.status !== 0) {
    errors.push(
      "hf CLI not found. Install with: pip install huggingface_hub[cli]",
    );
  }

  return errors;
}

/**
 * Publish one voice sub-model path.
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

  console.log(`\n--- ${TARGET_REPO}/${model.path} ---`);
  console.log(`    ${model.description}`);
  console.log(`    Staging: ${stagingDir}`);

  if (onlyWithBinaries && !stagingDirHasBinary(stagingDir)) {
    return {
      success: true,
      skipped: true,
      reason: `no binary payloads found in ${stagingDir}`,
    };
  }

  const missingRequired = (model.requiredFiles ?? []).filter(
    (rel) => !existsSync(join(stagingDir, rel)),
  );
  if (missingRequired.length > 0) {
    return {
      success: false,
      skipped: false,
      reason: `missing required staging file(s): ${missingRequired.join(", ")}`,
    };
  }

  // Step 1: Create the repo (idempotent — fails silently if exists)
  console.log("\n  [1/2] Create HF repo (idempotent)");
  const createResult = run(
    `hf repos create ${TARGET_REPO} --type model --exist-ok`,
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
    `hf upload ${TARGET_REPO} ${stagingDir} ${model.path} --type model ` +
      `--commit-message "Hydrate Eliza-1 voice binary payloads"`,
  );

  if (!isDryRun && uploadResult.status !== 0) {
    return {
      success: false,
      skipped: false,
      reason: `hf upload exited with status ${uploadResult.status}`,
    };
  }

  return { success: true, skipped: false };
}

function stagingDirHasBinary(stagingDir) {
  try {
    const out = execSync(
      `find ${JSON.stringify(stagingDir)} -type f \\( -name '*.gguf' -o -name '*.onnx' -o -name '*.bin' \\) -print -quit`,
      { encoding: "utf-8" },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
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
    console.log(`  [${status}] ${TARGET_REPO}/${r.model.path}${note}`);
    if (!r.success && !r.skipped) allOk = false;
  }

  if (!allOk) {
    console.error("\nSome payloads failed to publish. See output above.");
    process.exit(1);
  } else {
    console.log(
      isDryRun
        ? "\nDry run complete."
        : "\nAll payloads published successfully.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
