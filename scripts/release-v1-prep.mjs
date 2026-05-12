#!/usr/bin/env node
/**
 * release-v1-prep.mjs — run every Eliza-1 v1 release step that does NOT need a
 * GPU / Metal / Android / HF-write host, and print the checklist of what's left
 * (and which hardware each remaining step needs).
 *
 * This is the "to ship v1, here's what's already green and here's what's still
 * blocked" command. It is the runnable companion to RELEASE_V1.md (the runbook)
 * and ELIZA_1_TESTING_TODO.md (the QA checklist) — every `[hw]` line there
 * shows up here as a "remaining (needs <host>)" entry.
 *
 * What it runs (each must exit 0):
 *   1. build-llama-cpp-dflash.mjs --target linux-x64-cpu --dry-run  (build plumbing sane)
 *   2. python -m pytest packages/training/scripts/manifest/          (bundle/manifest/platform-plan/source-staging/evidence)
 *   3. packages/training/scripts/quantization/test_recipes_smoke.py  (TBQ/QJL/Polar recipe parity + codebook-hash pins)
 *   4. python -m py_compile on the release-pipeline scripts           (no syntax rot)
 *   5. each quant recipe --dry-run (turboquant/fused_turboquant/qjl/polarquant) (CLI + recipe params)
 *   6. distill_dflash_drafter.py --tier 1_7b --synthetic-smoke        (DFlash distill pipeline + GGUF metadata write, no torch)
 *   7. eliza1_platform_plan.py regenerates ELIZA_1_GGUF_{PLATFORM_PLAN.json,READINESS.md} idempotently
 *   8. eliza1_gates_collect.mjs --tier <each> --json                  (gate-collect with needs-data placeholders, no eval bytes)
 *   9. make -C packages/inference/verify reference-test kernel-contract  (CPU C reference + kernel-contract sync) — only if `make`/`cc` present
 *
 * What it does NOT run (prints them as the remaining checklist):
 *   - Fork build with kernel patches per backend; metal/vulkan/cuda/rocm verify; platform-dispatch smokes (target HW)
 *   - PolarQuant code generation, TurboQuant skip-layer calibration (a GPU big enough for the tier)
 *   - The DFlash real distillation run (GPU)
 *   - The base-v1 evals: text perplexity vs upstream GGUF, voice RTF, ASR WER, VAD latency, dflash acceptance, e2e loop, 30-turn, mobile RSS/thermal (GPU + reference devices)
 *   - Acquiring the base weights + staging a full bundle (network host; stage_eliza1_bundle_assets.py / stage_eliza1_source_weights.py)
 *   - publish_all_eliza1.sh real upload (HF_TOKEN with write to elizaos/*)
 *   - scripts/hf-transfer-eliza1.sh --execute (HF_TOKEN with write to milady-ai + elizaos)
 *
 * Usage:
 *   bun run release:v1:prep            # run the no-HW steps, print the checklist
 *   bun run release:v1:prep --quick    # skip the slower steps (recipe smoke, make reference-test)
 *   node scripts/release-v1-prep.mjs --json   # machine-readable summary on stdout
 *
 * Exit: 0 if every no-HW step passed; non-zero if any failed (the checklist of
 * remaining HW steps is informational and never affects the exit code).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const JSON_OUT = args.includes("--json");

/** @type {{name:string, status:"ok"|"fail"|"skipped", detail?:string}[]} */
const results = [];

function have(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "command", ["-v", cmd], {
    shell: true,
    stdio: "ignore",
  });
  return r.status === 0;
}

function step(name, cmd, cmdArgs, { cwd = REPO_ROOT, env = {}, allowMissing = null } = {}) {
  if (allowMissing && !have(allowMissing)) {
    results.push({ name, status: "skipped", detail: `'${allowMissing}' not on PATH` });
    if (!JSON_OUT) console.log(`  SKIP  ${name}  ('${allowMissing}' not on PATH)`);
    return;
  }
  if (!JSON_OUT) console.log(`  ...   ${name}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: JSON_OUT ? "pipe" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const ok = r.status === 0;
  let detail;
  if (!ok) {
    const tail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-8).join("\n");
    detail = `exit ${r.status}${tail ? `\n${tail}` : ""}`;
  }
  results.push({ name, status: ok ? "ok" : "fail", detail });
  if (!JSON_OUT) console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}${ok ? "" : `  — exit ${r.status}`}`);
  if (!ok && !JSON_OUT && detail) console.log(detail.split("\n").map((l) => `        ${l}`).join("\n"));
}

if (!JSON_OUT) {
  console.log("=== Eliza-1 v1 release prep — no-hardware steps ===\n");
  console.log("Runbook: RELEASE_V1.md   QA checklist: ELIZA_1_TESTING_TODO.md");
  console.log("HW catalog: packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md\n");
}

// --- 1. Build plumbing ---------------------------------------------------------
step(
  "build-llama-cpp-dflash.mjs --target linux-x64-cpu --dry-run",
  "node",
  ["packages/app-core/scripts/build-llama-cpp-dflash.mjs", "--target", "linux-x64-cpu", "--dry-run"],
);

// --- 2. Manifest / bundle / platform-plan / source-staging / evidence tests ----
step(
  "pytest packages/training/scripts/manifest/",
  "python3",
  ["-m", "pytest", "packages/training/scripts/manifest/", "-q"],
);

// --- 3. Quant recipe parity + codebook-hash pins (slower) ----------------------
if (!QUICK) {
  step(
    "quantization/test_recipes_smoke.py",
    "python3",
    ["packages/training/scripts/quantization/test_recipes_smoke.py"],
  );
}

// --- 4. py_compile the release-pipeline scripts --------------------------------
const PY_SCRIPTS = [
  "packages/training/scripts/run_pipeline.py",
  "packages/training/scripts/distill_dflash_drafter.py",
  "packages/training/scripts/publish_eliza1_model.py",
  "packages/training/scripts/push_model_to_hf.py",
  "packages/training/scripts/publish/orchestrator.py",
  "packages/training/scripts/quantization/turboquant_apply.py",
  "packages/training/scripts/quantization/fused_turboquant_apply.py",
  "packages/training/scripts/quantization/qjl_apply.py",
  "packages/training/scripts/quantization/polarquant_apply.py",
  "packages/training/scripts/quantization/gguf_eliza1_apply.py",
  "packages/training/scripts/manifest/stage_local_eliza1_bundle.py",
  "packages/training/scripts/manifest/stage_eliza1_bundle_assets.py",
  "packages/training/scripts/manifest/stage_eliza1_source_weights.py",
  "packages/training/scripts/manifest/eliza1_manifest.py",
  "packages/training/scripts/manifest/eliza1_platform_plan.py",
  "packages/training/scripts/manifest/finalize_eliza1_evidence.py",
];
step("py_compile release-pipeline scripts", "python3", ["-m", "py_compile", ...PY_SCRIPTS]);

// --- 5. Quant recipe --dry-runs (CLI surface + recipe params) ------------------
for (const [label, script, extra] of [
  ["turboquant_apply --dry-run", "turboquant_apply.py", []],
  ["fused_turboquant_apply --dry-run", "fused_turboquant_apply.py", []],
  ["qjl_apply --dry-run", "qjl_apply.py", []],
]) {
  step(
    label,
    "python3",
    [
      `packages/training/scripts/quantization/${script}`,
      "--model",
      "Qwen/Qwen3-0.6B",
      "--output",
      `${process.env.TMPDIR || "/tmp"}/eliza1-prep-${script}`,
      "--dry-run",
      ...extra,
    ],
  );
}
step(
  "polarquant_apply --dry-run",
  "python3",
  [
    "packages/training/scripts/quantization/polarquant_apply.py",
    "--model",
    "Qwen/Qwen3-0.6B",
    "--output",
    `${process.env.TMPDIR || "/tmp"}/eliza1-prep-polarquant`,
    "--dry-run",
  ],
);

// --- 6. DFlash distill synthetic smoke (no torch / GPU) ------------------------
step(
  "distill_dflash_drafter.py --tier 1_7b --synthetic-smoke",
  "python3",
  [
    "packages/training/scripts/distill_dflash_drafter.py",
    "--tier",
    "1_7b",
    "--synthetic-smoke",
    "--out-dir",
    `${process.env.TMPDIR || "/tmp"}/eliza1-prep-dflash-smoke`,
  ],
);

// --- 7. Platform plan regenerates idempotently --------------------------------
{
  const planPath = path.join(REPO_ROOT, "ELIZA_1_GGUF_PLATFORM_PLAN.json");
  const mdPath = path.join(REPO_ROOT, "ELIZA_1_GGUF_READINESS.md");
  const before = [planPath, mdPath].map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""));
  step(
    "eliza1_platform_plan.py regenerates ELIZA_1_GGUF_{PLATFORM_PLAN.json,READINESS.md}",
    "python3",
    [
      "packages/training/scripts/manifest/eliza1_platform_plan.py",
      "--out",
      "ELIZA_1_GGUF_PLATFORM_PLAN.json",
      "--readiness-md",
      "ELIZA_1_GGUF_READINESS.md",
    ],
  );
  const after = [planPath, mdPath].map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""));
  if (before[0] !== after[0] || before[1] !== after[1]) {
    results.push({
      name: "eliza1_platform_plan.py idempotency",
      status: "fail",
      detail: "regenerating ELIZA_1_GGUF_PLATFORM_PLAN.json / ELIZA_1_GGUF_READINESS.md changed them — commit the regenerated files",
    });
    if (!JSON_OUT) console.log("  FAIL  eliza1_platform_plan.py idempotency — regenerated files differ; commit them");
  } else {
    results.push({ name: "eliza1_platform_plan.py idempotency", status: "ok" });
    if (!JSON_OUT) console.log("  OK    eliza1_platform_plan.py idempotency");
  }
}

// --- 8. Gate-collect per tier (needs-data placeholders, no eval bytes) --------
for (const tier of ["0_6b", "1_7b", "9b", "27b", "27b-256k", "27b-1m"]) {
  step(
    `eliza1_gates_collect.mjs --tier ${tier} --json`,
    "node",
    ["packages/inference/verify/eliza1_gates_collect.mjs", "--tier", tier, "--json"],
  );
}

// --- 9. CPU C reference + kernel-contract (only with make/cc) ------------------
if (!QUICK) {
  step(
    "make -C packages/inference/verify reference-test",
    "make",
    ["-C", "packages/inference/verify", "reference-test"],
    { allowMissing: "make" },
  );
  step(
    "make -C packages/inference/verify kernel-contract",
    "make",
    ["-C", "packages/inference/verify", "kernel-contract"],
    { allowMissing: "make" },
  );
}

// --- Summary -------------------------------------------------------------------
const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skipped");
const ok = results.filter((r) => r.status === "ok");

const REMAINING_HW = [
  ["Fork build per backend + metal/vulkan/cuda/rocm verify + platform-dispatch smokes", "the target backend's hardware (Metal Mac, CUDA NVIDIA, Vulkan Linux/Android, ROCm AMD; GH200-class aarch64+CUDA for 27b-1m)", "node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>; make -C packages/inference/verify {metal,vulkan,cuda,rocm}_verify; verify/{cuda,rocm,gh200}_runner.sh / windows_runner.ps1"],
  ["PolarQuant code generation + TurboQuant skip-layer calibration", "a GPU big enough for the tier (consumer for 0.6B/1.7B; ≥24 GB for 9B; ≥48 GB / multi-GPU for 27B)", "uv run --extra train python packages/training/scripts/quantization/{polarquant,turboquant}_apply.py --model <hf-ckpt> --output ... --device cuda"],
  ["DFlash drafter real distillation run", "a GPU (the student forwards the dataset)", "uv run --extra train python packages/training/scripts/distill_dflash_drafter.py --tier <t> --target-checkpoint <dir> --target-gguf <gguf> --student-base <qwen3> --dataset <jsonl> --out-dir ..."],
  ["Acquire the base weights + stage the full bundle", "a network host (the source GGUFs/safetensors download)", "uv run python packages/training/scripts/manifest/stage_eliza1_source_weights.py --tier <t> --bundle-dir ...; uv run python packages/training/scripts/manifest/stage_eliza1_bundle_assets.py --tier <t> --bundle-dir ... --link-mode hardlink; uv run python packages/training/scripts/manifest/stage_local_eliza1_bundle.py --tier <t> --all-contexts --bundle-dir ... --release-state base-v1"],
  ["base-v1 evals: text perplexity vs upstream GGUF, voice RTF, ASR WER, VAD latency, dflash acceptance, e2e loop, 30-turn, mobile RSS/thermal", "a GPU big enough for the tier + reference devices for mobile/voice", "node packages/inference/verify/dflash_drafter_runtime_smoke.mjs --bench; bun run voice:interactive; node packages/inference/verify/{thirty_turn_endurance,mobile_peak_rss,bargein_latency}_harness.mjs; uv run python -m packages.training.benchmarks.eliza1_gates <aggregate.json>"],
  ["Publish to HuggingFace under elizaos/eliza-1-<tier>", "HF_TOKEN with write access to elizaos/*", "bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir> --dry-run  (then drop --dry-run)"],
  ["Move legacy HF repos out of milady-ai into elizaos + create the per-tier bundle repos", "HF_TOKEN with write access to BOTH milady-ai and elizaos", "bash scripts/hf-transfer-eliza1.sh           (dry-run; then --execute)"],
];

if (JSON_OUT) {
  console.log(JSON.stringify({ noHardwareSteps: results, remainingHardware: REMAINING_HW.map(([what, host, cmd]) => ({ what, host, cmd })), ok: failed.length === 0 }, null, 2));
} else {
  console.log("");
  console.log(`=== No-hardware steps: ${ok.length} ok, ${failed.length} failed, ${skipped.length} skipped ===`);
  if (failed.length) {
    console.log("\nFailed steps (these are real regressions — fix before shipping):");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `\n      ${f.detail.split("\n").join("\n      ")}` : ""}`);
  }
  console.log("\n=== Remaining: needs hardware / network / HF credentials ===");
  console.log("(also in ELIZA_1_TESTING_TODO.md as [hw] lines, with per-backend detail in needs-hardware-ledger.md)\n");
  for (const [what, host, cmd] of REMAINING_HW) {
    console.log(`  [ ] ${what}`);
    console.log(`      host: ${host}`);
    console.log(`      run:  ${cmd}`);
    console.log("");
  }
  console.log(failed.length ? "release:v1:prep FAILED — see failed steps above." : "release:v1:prep OK — every no-hardware step passed. The remaining work is the hardware/network/HF list above.");
}

process.exit(failed.length === 0 ? 0 : 1);
