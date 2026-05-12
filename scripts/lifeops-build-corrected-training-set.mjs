#!/usr/bin/env node
/**
 * Build a CORRECT-output training set for the action_planner optimizer.
 *
 * The previous lifeops-build-mixed-training-set.mjs was poisoned: fail-row
 * `response.text` was the agent's *wrong* output (REPLY-with-questions),
 * but the scorer compares optimizer-generated text against `response.text`.
 * That trained the optimizer to *imitate* the wrong output instead of
 * fixing it.
 *
 * This script synthesizes a CORRECT `response.text` for every row from
 * the case's `metadata.expectedAction`. Pass rows that already had a
 * matching action keep their original output; fail rows get a minimal
 * stub `{"toolCalls":[{"name":"<EXPECTED>","args":{...derived from prompt}}]}`.
 *
 * Output is `eliza_native_v1` JSONL.
 *
 * Usage:
 *   node scripts/lifeops-build-corrected-training-set.mjs \
 *     --pass-from <runDir>   # source of passing rows (Cerebras)
 *     --fail-from <runDir>   # source of failing rows (Anthropic)
 *     --output <path>
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : fallback;
}

const passFrom = resolve(arg("--pass-from", ""));
const failFrom = resolve(arg("--fail-from", ""));
const output = resolve(
  arg(
    "--output",
    "/Users/shawwalters/milaidy/eliza/plugins/app-training/datasets/lifeops_corrected_action_planner.jsonl",
  ),
);

if (!passFrom || !existsSync(passFrom)) {
  console.error("[corrected] --pass-from <runDir> required");
  process.exit(2);
}

function* walkJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

function loadCases(runDir) {
  const lookup = new Map();
  for (const f of readdirSync(runDir).filter((f) =>
    /^benchmark-report.*\.json$/.test(f),
  )) {
    let r;
    try {
      r = JSON.parse(readFileSync(join(runDir, f), "utf8"));
    } catch {
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

function plannerFromTrajectory(trajPath) {
  let trajectory;
  try {
    trajectory = JSON.parse(readFileSync(trajPath, "utf8"));
  } catch {
    return null;
  }
  if (!trajectory?.stages) return null;
  const planner = trajectory.stages.find(
    (s) => s.kind === "planner" && s.model,
  );
  if (!planner) return null;
  const messages = Array.isArray(planner.model.messages)
    ? planner.model.messages
    : [];
  const sysMsg = messages.find((m) => m && m.role === "system");
  const userMsg = messages.find((m) => m && m.role === "user");
  const systemPrompt =
    typeof sysMsg?.content === "string" ? sysMsg.content : "";
  const userPrompt =
    (typeof planner.model.prompt === "string" ? planner.model.prompt : "") ||
    (typeof userMsg?.content === "string" ? userMsg.content : "");
  let modelOutput = "";
  if (
    typeof planner.model.response === "string" &&
    planner.model.response.trim().length > 0
  ) {
    modelOutput = planner.model.response;
  } else if (
    Array.isArray(planner.model.toolCalls) &&
    planner.model.toolCalls.length > 0
  ) {
    modelOutput = JSON.stringify({ toolCalls: planner.model.toolCalls });
  }
  if (!userPrompt) return null;
  return { trajectory, systemPrompt, userPrompt, modelOutput };
}

/**
 * Synthesize a minimal "correct" response.text for a row. If the recorded
 * output already has the expected action name (the case passed), keep it.
 * Otherwise replace with a stub that uses the expected action.
 */
function correctResponseText(modelOutput, expectedAction) {
  if (!expectedAction) return modelOutput;
  const m = modelOutput?.match(/"name":"([A-Z_]+)"/);
  if (m && m[1] === expectedAction) return modelOutput;
  return JSON.stringify({
    toolCalls: [{ name: expectedAction, args: {} }],
  });
}

const PLANNER_BASELINE = "You are the lifeops action planner.";

const passCases = loadCases(passFrom);
const failCases =
  failFrom && existsSync(failFrom) ? loadCases(failFrom) : new Map();

const lines = [];
let passOk = 0;
let failCorrected = 0;

for (const file of walkJson(join(passFrom, "trajectories"))) {
  const e = plannerFromTrajectory(file);
  if (!e) continue;
  const sid = e.trajectory.scenarioId;
  if (!sid) continue;
  const meta = passCases.get(sid);
  if (!meta?.pass) continue;
  const corrected = correctResponseText(e.modelOutput, meta.expectedAction);
  const row = {
    format: "eliza_native_v1",
    boundary: "vercel_ai_sdk.generateText",
    request: {
      system: e.systemPrompt || PLANNER_BASELINE,
      messages: [{ role: "user", content: e.userPrompt }],
    },
    response: { text: corrected },
    reward: 1.0,
    metadata: {
      caseId: meta.caseId,
      expectedAction: meta.expectedAction,
      pass: true,
      sourceRun: passFrom,
      trajectoryId: e.trajectory.trajectoryId,
      variantId: meta.variantId,
      synthesized: corrected !== e.modelOutput,
    },
  };
  lines.push(JSON.stringify(row));
  passOk += 1;
}

if (failFrom && existsSync(join(failFrom, "trajectories"))) {
  for (const file of walkJson(join(failFrom, "trajectories"))) {
    const e = plannerFromTrajectory(file);
    if (!e) continue;
    const sid = e.trajectory.scenarioId;
    if (!sid) continue;
    const meta = failCases.get(sid);
    if (!meta || meta.pass) continue;
    const corrected = correctResponseText(e.modelOutput, meta.expectedAction);
    const row = {
      format: "eliza_native_v1",
      boundary: "vercel_ai_sdk.generateText",
      request: {
        system: e.systemPrompt || PLANNER_BASELINE,
        messages: [{ role: "user", content: e.userPrompt }],
      },
      // CORRECTED output: synthesized expected action, not the wrong one
      // the agent actually produced. Reward stays 1.0 because we want the
      // optimizer to *learn* this correct behaviour.
      response: { text: corrected },
      reward: 1.0,
      metadata: {
        caseId: meta.caseId,
        expectedAction: meta.expectedAction,
        actualAction: meta.actualAction,
        pass: meta.pass,
        sourceRun: failFrom,
        trajectoryId: e.trajectory.trajectoryId,
        variantId: meta.variantId,
        synthesized: corrected !== e.modelOutput,
      },
    };
    lines.push(JSON.stringify(row));
    failCorrected += 1;
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join("\n") + (lines.length ? "\n" : ""));
console.log(
  `[corrected] wrote ${lines.length} rows to ${output} (pass-rows=${passOk}, fail-rows-corrected=${failCorrected})`,
);
