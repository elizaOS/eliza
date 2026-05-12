#!/usr/bin/env node
/**
 * Build a *labelled* training set for the action_planner native optimizer
 * by mixing pass rows from one run (e.g. Cerebras 84% accuracy) with
 * fail rows from another run (e.g. Anthropic 5% accuracy).
 *
 * The optimizer's instruction-search needs reward variation: with all
 * `reward: 0` rows, baseline and optimized scores both collapse to 0.
 * Cerebras pass rows give the scorer something to imitate; Anthropic
 * fail rows preserve the prompts the prompt needs to handle.
 *
 * Output is `eliza_native_v1` JSONL (matches
 * plugins/app-training/src/backends/native.ts:parseJsonlDataset).
 *
 * Usage:
 *   node scripts/lifeops-build-mixed-training-set.mjs \
 *     --pass-from <runDir>   # source of passing rows (e.g. Cerebras run)
 *     --fail-from <runDir>   # source of failing rows (e.g. Anthropic run)
 *     --output <path>        # destination JSONL
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const passFrom = resolve(arg("--pass-from", ""));
const failFrom = resolve(arg("--fail-from", ""));
const output = resolve(
  arg(
    "--output",
    "/Users/shawwalters/milaidy/eliza/plugins/app-training/datasets/lifeops_mixed_action_planner.jsonl",
  ),
);

if (!passFrom || !existsSync(passFrom)) {
  console.error("[mixed] --pass-from <runDir> required");
  process.exit(2);
}

const PLANNER_BASELINE =
  "You are the lifeops action planner for an elizaOS agent. Read the conversation and the list of available actions, then choose the single best action (or REPLY when no action is needed).";

function* walkJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

function loadCases(runDir) {
  const reports = readdirSync(runDir)
    .filter((f) => /^benchmark-report.*\.json$/.test(f))
    .map((f) => join(runDir, f));
  const lookup = new Map();
  for (const reportFile of reports) {
    let r;
    try {
      r = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch (err) {
      continue;
    }
    for (const result of r.results ?? []) {
      if (!result?.case?.caseId) continue;
      lookup.set(result.case.caseId, {
        caseId: result.case.caseId,
        expectedAction: result.case.expectedAction ?? null,
        actualAction: result.actualPrimaryAction ?? null,
        pass: !!result.pass,
        variantId: result.case.variantId ?? null,
        suiteId: result.case.suiteId ?? null,
      });
    }
  }
  return lookup;
}

function plannerFromTrajectory(trajPath, cases) {
  let trajectory;
  try {
    trajectory = JSON.parse(readFileSync(trajPath, "utf8"));
  } catch {
    return null;
  }
  if (!trajectory?.stages) return null;
  const planner = trajectory.stages.find((s) => s.kind === "planner" && s.model);
  if (!planner) return null;
  // Capture the FULL recorded prompt (system block + user) so the optimizer
  // sees the runtime context the agent actually had. Otherwise the scorer's
  // model has nothing to ground LIFE/CALENDAR/etc. against.
  let systemPrompt = "";
  const messages = Array.isArray(planner.model.messages) ? planner.model.messages : [];
  const sysMsg = messages.find((m) => m && m.role === "system");
  systemPrompt = typeof sysMsg?.content === "string" ? sysMsg.content : "";
  const userMsg = messages.find((m) => m && m.role === "user");
  const userPrompt =
    (typeof planner.model.prompt === "string" ? planner.model.prompt : "") ||
    (typeof userMsg?.content === "string" ? userMsg.content : "");
  let modelOutput = "";
  if (typeof planner.model.response === "string" && planner.model.response.trim().length > 0) {
    modelOutput = planner.model.response;
  } else if (Array.isArray(planner.model.toolCalls) && planner.model.toolCalls.length > 0) {
    modelOutput = JSON.stringify({ toolCalls: planner.model.toolCalls });
  }
  if (!userPrompt || !modelOutput) return null;
  const meta = trajectory.scenarioId ? cases.get(trajectory.scenarioId) : null;
  return { trajectory, planner, systemPrompt, userPrompt, modelOutput, meta };
}

function rowFromTrajectory(extracted, runDir) {
  const { trajectory, systemPrompt, userPrompt, modelOutput, meta } = extracted;
  return {
    format: "eliza_native_v1",
    boundary: "vercel_ai_sdk.generateText",
    request: {
      // Include the FULL recorded system prompt so the optimizer's scorer
      // model (Cerebras gpt-oss-120b) has the same provider blocks, action
      // catalog, and conversation context the original agent had. Without
      // this, the optimizer has no grounding to reproduce LIFE/CALENDAR/etc.
      system: systemPrompt || PLANNER_BASELINE,
      messages: [{ role: "user", content: userPrompt }],
    },
    response: { text: modelOutput },
    reward: meta?.pass ? 1.0 : 0.0,
    metadata: {
      caseId: meta?.caseId ?? trajectory.scenarioId,
      expectedAction: meta?.expectedAction ?? null,
      actualAction: meta?.actualAction ?? null,
      pass: meta?.pass ?? null,
      variantId: meta?.variantId ?? null,
      suiteId: meta?.suiteId ?? null,
      scenario: trajectory.scenarioId ?? null,
      runId: trajectory.runId ?? null,
      sourceRun: runDir,
      trajectoryId: trajectory.trajectoryId,
    },
  };
}

const passCases = loadCases(passFrom);
const failCases = failFrom && existsSync(failFrom) ? loadCases(failFrom) : new Map();

const lines = [];
let passCount = 0;
let failCount = 0;

const passTrajDir = join(passFrom, "trajectories");
if (existsSync(passTrajDir)) {
  for (const file of walkJson(passTrajDir)) {
    const extracted = plannerFromTrajectory(file, passCases);
    if (!extracted) continue;
    if (!extracted.meta?.pass) continue;
    const row = rowFromTrajectory(extracted, passFrom);
    lines.push(JSON.stringify(row));
    passCount += 1;
  }
}

if (failFrom && existsSync(join(failFrom, "trajectories"))) {
  const failTrajDir = join(failFrom, "trajectories");
  for (const file of walkJson(failTrajDir)) {
    const extracted = plannerFromTrajectory(file, failCases);
    if (!extracted) continue;
    if (extracted.meta?.pass) continue;
    const row = rowFromTrajectory(extracted, failFrom);
    lines.push(JSON.stringify(row));
    failCount += 1;
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join("\n") + (lines.length ? "\n" : ""));
console.log(
  `[mixed] wrote ${lines.length} rows to ${output} (passes=${passCount}, fails=${failCount})`,
);
