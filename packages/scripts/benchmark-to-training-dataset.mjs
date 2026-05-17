#!/usr/bin/env node
/**
 * benchmark-to-training-dataset.mjs
 *
 * Converts action-benchmark-report/cases/*.json trajectories into a
 * JSONL dataset that the native training backend accepts.
 *
 * Output shape (one per line — matches `GeminiTuningExample` expected by
 * plugins/app-training/src/backends/native.ts `parseJsonlDataset`):
 *   {
 *     "messages": [
 *       { "role": "system", "content": "<optional> " },
 *       { "role": "user",   "content": "<full planner prompt>" },
 *       { "role": "model",  "content": "<planner response>" }
 *     ],
 *     "reward": 1.0 | 0.0,
 *     "metadata": { caseId, expectedAction, actualAction, pass }
 *   }
 *
 * The native backend ignores `reward` / `metadata` fields when parsing rows
 * (it only reads `messages`), so the extras are captured for downstream
 * reward-aware optimizers and meta.json bookkeeping without breaking the
 * JSONL contract.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const CASES_DIR = join(REPO_ROOT, "action-benchmark-report", "cases");
const OUT_DIR = join(REPO_ROOT, "plugins", "app-training", "datasets");
const OUT_JSONL = join(OUT_DIR, "action_planner_from_benchmark.jsonl");
const OUT_META = join(OUT_DIR, "action_planner_from_benchmark.meta.json");

/**
 * Baseline planner instruction. The native optimizer mutates this to search
 * for better planner guidance; the per-row user prompt already contains the
 * full action catalog + conversation context so this string only needs to
 * express the invariant task framing.
 */
const DEFAULT_PLANNER_BASELINE =
  "You are the action planner for an elizaOS agent. Read the conversation and the list of available actions, then choose the single best action (or REPLY when no action is needed). Match the user's literal intent over loose keyword overlap: prefer the action whose description, similes, and examples align with what the user actually asked for, and avoid actions whose negative guards rule out the current request. Respond with the exact XML the planner format expects.";

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function listCaseFiles() {
  if (!existsSync(CASES_DIR)) {
    throw new Error(`cases directory not found: ${CASES_DIR}`);
  }
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(CASES_DIR, f));
}

function firstPlannerCall(caseData) {
  const calls = caseData?.agentTrajectory?.llmCalls;
  if (!Array.isArray(calls)) return null;
  return calls.find((c) => c && c.purpose === "action_planner") ?? null;
}

function buildRow(caseData) {
  const planner = firstPlannerCall(caseData);
  if (!planner) {
    return { row: null, reason: "no_action_planner_call" };
  }
  const prompt =
    typeof planner.prompt === "string" ? planner.prompt.trim() : "";
  const response =
    typeof planner.response === "string" ? planner.response.trim() : "";
  if (!prompt) return { row: null, reason: "empty_prompt" };
  if (!response) return { row: null, reason: "empty_response" };

  const metadata = caseData.metadata ?? {};
  const pass = metadata.pass === true;
  const row = {
    messages: [
      { role: "system", content: DEFAULT_PLANNER_BASELINE },
      { role: "user", content: prompt },
      { role: "model", content: response },
    ],
    reward: pass ? 1.0 : 0.0,
    metadata: {
      caseId: caseData.caseId ?? null,
      expectedAction: metadata.expectedAction ?? null,
      plannedAction: metadata.plannedAction ?? null,
      actualAction: metadata.actualAction ?? null,
      pass,
      failureMode: metadata.failureMode ?? null,
    },
  };
  return { row, reason: null };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = listCaseFiles();

  const rows = [];
  const rejects = [];
  let passCount = 0;
  let failCount = 0;

  for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    const { row, reason } = buildRow(data);
    if (!row) {
      rejects.push({ file, reason });
      continue;
    }
    rows.push(row);
    if (row.reward >= 1.0) passCount += 1;
    else failCount += 1;
  }

  const jsonl =
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(OUT_JSONL, jsonl);

  const meta = {
    datasetId: `action-benchmark-${gitSha()}`,
    generatedAt: new Date().toISOString(),
    casesDir: CASES_DIR,
    caseCount: files.length,
    rowCount: rows.length,
    passCount,
    failCount,
    rejectedCount: rejects.length,
    rejects,
    task: "action_planner",
    format: "gemini-messages-jsonl+reward",
  };
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

  console.log(`[benchmark-to-dataset] cases scanned: ${files.length}`);
  console.log(
    `[benchmark-to-dataset] rows emitted: ${rows.length} (pass=${passCount} fail=${failCount})`,
  );
  console.log(`[benchmark-to-dataset] rejected: ${rejects.length}`);
  for (const r of rejects) {
    console.log(`  - ${r.file}: ${r.reason}`);
  }
  console.log(`[benchmark-to-dataset] wrote ${OUT_JSONL}`);
  console.log(`[benchmark-to-dataset] wrote ${OUT_META}`);
}

main();
