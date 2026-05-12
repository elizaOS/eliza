#!/usr/bin/env node
/**
 * Convert a lifeops-prompt-benchmark run (report.json + trajectories/) into
 * a JSONL training dataset that the native optimizer accepts.
 *
 * Pulls planner prompt + response from the recorded trajectories (not the
 * benchmark report's truncated capture), pairs them with the case's pass/
 * fail label as `reward`, and writes one row per case.
 *
 * Usage:
 *   node scripts/lifeops-benchmark-to-training-dataset.mjs \
 *     --run-dir <runDir> \
 *     [--output plugins/app-training/datasets/lifeops_action_planner.jsonl]
 *
 * The output path defaults to:
 *   plugins/app-training/datasets/lifeops_action_planner_from_benchmark.jsonl
 *
 * Output row shape (matches `parseJsonlDataset` in
 * plugins/app-training/src/backends/native.ts):
 *   {
 *     "messages": [
 *       { "role": "system", "content": "<planner instruction>" },
 *       { "role": "user",   "content": "<full planner prompt>" },
 *       { "role": "model",  "content": "<planner response>" }
 *     ],
 *     "reward": 1.0 | 0.0,
 *     "metadata": { caseId, expectedAction, actualAction, pass, scenario, runId }
 *   }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : fallback;
}

const runDir = resolve(arg("--run-dir", ""));
if (!runDir || !existsSync(runDir)) {
  console.error(
    "[bench->ds] --run-dir <dir> required (e.g. ~/.milady/runs/lifeops/lifeops-bench-...)",
  );
  process.exit(2);
}

const outputDefault = join(
  REPO_ROOT,
  "plugins",
  "app-training",
  "datasets",
  "lifeops_action_planner_from_benchmark.jsonl",
);
const outputPath = resolve(arg("--output", outputDefault));
mkdirSync(dirname(outputPath), { recursive: true });

const trajectoryDir = join(runDir, "trajectories");
if (!existsSync(trajectoryDir)) {
  console.error(`[bench->ds] no trajectory dir: ${trajectoryDir}`);
  process.exit(2);
}

const PLANNER_BASELINE =
  "You are the lifeops action planner. Read the user's message and the available actions, then choose the single best action (or REPLY when no action is needed). Output the structured planner response exactly as expected.";

function* walkJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

const benchmarkReports = readdirSync(runDir)
  .filter((f) => /^benchmark-report.*\.json$/.test(f))
  .map((f) => join(runDir, f));

const caseLookup = new Map();
for (const reportFile of benchmarkReports) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch (err) {
    console.warn(`[bench->ds] skip ${reportFile}: ${err.message}`);
    continue;
  }
  for (const r of report.results ?? []) {
    if (!r?.case?.caseId) continue;
    caseLookup.set(r.case.caseId, {
      caseId: r.case.caseId,
      expectedAction: r.case.expectedAction ?? null,
      actualAction: r.actualPrimaryAction ?? null,
      pass: !!r.pass,
      variantId: r.case.variantId ?? null,
      suiteId: r.case.suiteId ?? null,
    });
  }
}

if (caseLookup.size === 0) {
  console.warn(
    `[bench->ds] no benchmark-report*.json found under ${runDir}; emitting rows without pass labels (reward=0)`,
  );
}

let rows = 0;
let skipped = 0;
const lines = [];

for (const file of walkJson(trajectoryDir)) {
  let trajectory;
  try {
    trajectory = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    skipped += 1;
    continue;
  }
  if (!trajectory.stages || !Array.isArray(trajectory.stages)) {
    skipped += 1;
    continue;
  }
  const planner = trajectory.stages.find((s) => s.kind === "planner" && s.model);
  if (!planner) {
    skipped += 1;
    continue;
  }
  const scenarioId = trajectory.scenarioId ?? null;
  const meta = scenarioId ? caseLookup.get(scenarioId) : null;

  // The planner prompt lives on `model.messages` (array of {role, content}).
  // Pick the user message; fall back to model.prompt if present.
  const userMsg = Array.isArray(planner.model.messages)
    ? planner.model.messages.find((m) => m && m.role === "user")
    : null;
  const userPrompt =
    (typeof planner.model.prompt === "string" ? planner.model.prompt : "") ||
    (typeof userMsg?.content === "string" ? userMsg.content : "");

  // The planner output is either prose (`model.response`) or tool calls
  // (`model.toolCalls`). Anthropic tool-use returns tool_calls with empty
  // response; serialize them as JSON so the optimizer has something to score.
  let modelOutput = "";
  if (typeof planner.model.response === "string" && planner.model.response.trim().length > 0) {
    modelOutput = planner.model.response;
  } else if (Array.isArray(planner.model.toolCalls) && planner.model.toolCalls.length > 0) {
    modelOutput = JSON.stringify({ toolCalls: planner.model.toolCalls });
  }

  if (!userPrompt || !modelOutput) {
    skipped += 1;
    continue;
  }

  // eliza_native_v1 shape (matches plugins/app-training/src/backends/native.ts:parseJsonlDataset)
  const row = {
    format: "eliza_native_v1",
    boundary: "vercel_ai_sdk.generateText",
    request: {
      system: PLANNER_BASELINE,
      messages: [
        { role: "user", content: userPrompt },
      ],
    },
    response: {
      text: modelOutput,
    },
    reward: meta?.pass ? 1.0 : 0.0,
    metadata: {
      caseId: meta?.caseId ?? scenarioId,
      expectedAction: meta?.expectedAction ?? null,
      actualAction: meta?.actualAction ?? null,
      pass: meta?.pass ?? null,
      variantId: meta?.variantId ?? null,
      suiteId: meta?.suiteId ?? null,
      scenario: scenarioId,
      runId: trajectory.runId ?? null,
      trajectoryId: trajectory.trajectoryId,
    },
  };
  lines.push(JSON.stringify(row));
  rows += 1;
}

writeFileSync(outputPath, lines.join("\n") + (lines.length ? "\n" : ""));
console.log(
  `[bench->ds] wrote ${rows} rows to ${outputPath} (skipped ${skipped})`,
);

const metaPath = `${outputPath.replace(/\.jsonl$/, "")}.meta.json`;
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runDir,
      benchmarkReports,
      rows,
      skipped,
      casesLabeled: caseLookup.size,
    },
    null,
    2,
  ) + "\n",
);
console.log(`[bench->ds] meta -> ${metaPath}`);
