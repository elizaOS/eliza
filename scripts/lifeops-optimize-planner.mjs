#!/usr/bin/env node
/**
 * Run the native instruction-search optimizer on a lifeops planner dataset.
 *
 * Pipeline:
 *   1. Convert benchmark report + recorded trajectories from <run-dir> into
 *      a JSONL training dataset (delegates to lifeops-benchmark-to-training-dataset.mjs).
 *   2. Invoke `bun run train` against the native backend with the configured
 *      optimizer + Cerebras teacher.
 *   3. Locate the produced artifact under
 *      ~/.milady/optimized-prompts/<task>/ and surface it.
 *   4. Optionally re-run a benchmark variant against the new prompt to
 *      capture before/after accuracy.
 *
 * Usage:
 *   node scripts/lifeops-optimize-planner.mjs \
 *     --run-dir ~/.milady/runs/lifeops/<id> \
 *     [--optimizer instruction-search]   # also: prompt-evolution, bootstrap-fewshot
 *     [--task action_planner]
 *     [--baseline plugins/app-lifeops/src/lifeops/prompt/planner-baseline.txt]
 *
 * Required env (sourced from eliza/.env automatically):
 *   - CEREBRAS_API_KEY       (judge / teacher)
 *   - TRAIN_MODEL_PROVIDER=cerebras
 *   - TRAIN_MODEL=gpt-oss-120b
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const runDir = resolve(arg("--run-dir", ""));
if (!runDir || !existsSync(runDir)) {
  console.error("[optimize-planner] --run-dir <dir> required");
  process.exit(2);
}
const optimizer = arg("--optimizer", "instruction-search");
const task = arg("--task", "action_planner");
const baseline = arg(
  "--baseline",
  join(
    REPO_ROOT,
    "plugins",
    "app-training",
    "datasets",
    "action_planner_baseline.txt",
  ),
);

const datasetPath = join(
  REPO_ROOT,
  "plugins",
  "app-training",
  "datasets",
  `lifeops_${task}_from_${runDir.split("/").pop()}.jsonl`,
);
mkdirSync(dirname(datasetPath), { recursive: true });

console.log(`[optimize-planner] runDir=${runDir}`);
console.log(`[optimize-planner] optimizer=${optimizer} task=${task}`);
console.log(`[optimize-planner] dataset=${datasetPath}`);

// 1. Convert.
console.log("\n[optimize-planner] ▶ converting benchmark + trajectories to JSONL");
const convert = spawnSync(
  "node",
  [
    "scripts/lifeops-benchmark-to-training-dataset.mjs",
    "--run-dir",
    runDir,
    "--output",
    datasetPath,
  ],
  { cwd: REPO_ROOT, stdio: "inherit" },
);
if (convert.status !== 0) {
  console.error("[optimize-planner] dataset conversion failed");
  process.exit(2);
}
const datasetSize = readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean).length;
if (datasetSize === 0) {
  console.error("[optimize-planner] dataset is empty; aborting");
  process.exit(2);
}
console.log(`[optimize-planner] dataset rows: ${datasetSize}`);

// 2. Ensure baseline file exists.
if (!existsSync(baseline)) {
  // Write a minimal baseline if the operator didn't supply one — the
  // optimizer will mutate it.
  mkdirSync(dirname(baseline), { recursive: true });
  const fallback =
    "You are the lifeops action planner. Read the user's message and the available actions, then choose the single best action (or REPLY when no action is needed). Respond with the structured planner JSON.\n";
  console.log(`[optimize-planner] writing fallback baseline -> ${baseline}`);
  spawnSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "_", fallback, baseline], {
    stdio: "inherit",
  });
}

// 3. Run optimizer.
console.log(`\n[optimize-planner] ▶ running ${optimizer} (Cerebras teacher)`);
const trainEnv = {
  ...process.env,
  TRAIN_MODEL_PROVIDER: process.env.TRAIN_MODEL_PROVIDER ?? "cerebras",
  TRAINING_PROVIDER: process.env.TRAINING_PROVIDER ?? "cerebras",
  TRAIN_MODEL: process.env.TRAIN_MODEL ?? "gpt-oss-120b",
  TRAINING_MODEL: process.env.TRAINING_MODEL ?? "gpt-oss-120b",
};
const trainArgs = [
  "run",
  "train",
  "--",
  "--backend",
  "native",
  "--optimizer",
  optimizer,
  "--task",
  task,
  "--dataset",
  datasetPath,
  "--baseline",
  baseline,
];
console.log(`[optimize-planner]   bun ${trainArgs.join(" ")}`);
const trainResult = spawnSync("bun", trainArgs, {
  cwd: REPO_ROOT,
  env: trainEnv,
  stdio: "inherit",
});
if (trainResult.status !== 0) {
  console.error(`[optimize-planner] training exited ${trainResult.status}`);
  process.exit(trainResult.status ?? 1);
}

// 4. Locate the produced artifact.
const stateDir = process.env.MILADY_STATE_DIR
  ? resolve(process.env.MILADY_STATE_DIR)
  : join(homedir(), ".milady");
const artifactDir = join(stateDir, "optimized-prompts", task);
const elizaArtifactDir = join(homedir(), ".eliza", "optimized-prompts", task);
const candidates = [artifactDir, elizaArtifactDir].filter(existsSync);
if (candidates.length === 0) {
  console.warn(
    `[optimize-planner] no artifact dir found at ${artifactDir} or ${elizaArtifactDir} — optimizer may not have written a file`,
  );
} else {
  for (const dir of candidates) {
    console.log(`\n[optimize-planner] artifact dir: ${dir}`);
    const files = readdirSync(dir)
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(0, 5)) {
      console.log(`  - ${f}`);
    }
  }
}

console.log(`\n[optimize-planner] DONE`);
