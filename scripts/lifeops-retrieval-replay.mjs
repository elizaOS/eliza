#!/usr/bin/env bun
/**
 * Retrieval replay — augment existing trajectories with `perStageScores`
 * + `correctActions` so the funnel + Pareto analyzers can count samples.
 *
 * The TS runtime only emits measurement when `ELIZA_RETRIEVAL_MEASUREMENT=1`
 * is set during the bench run. For the historical 600+ LifeOps trajectory
 * corpus that landed on disk before that flag existed, this script
 * deterministically re-runs `retrieveActions` over each stored user-message
 * query, derives `correctActions` from the actually-invoked `tool` stages
 * that follow it, and writes the augmented trajectories to a separate
 * output directory (default `~/.eliza/trajectories-replay/`). The funnel +
 * Pareto scripts can then be pointed at that directory.
 *
 * Why this is sound:
 *  - The retrieval pipeline is pure / deterministic. Re-running it over the
 *    same input text + same candidate hints reproduces what the runtime
 *    would have emitted under measurement mode.
 *  - The "correct action" proxy is the tool the planner ultimately invoked.
 *    That mirrors the production reality of what retrieval needed to surface
 *    to make the turn succeed. Tools listed in `FILTERED_TOOL_NAMES` are
 *    runtime housekeeping (BENCHMARK_ACTION wrapper, NONE, REPLY) that the
 *    retrieval pipeline never needs to consider — they are not counted.
 *
 * Usage:
 *   bun scripts/lifeops-retrieval-replay.mjs
 *   bun scripts/lifeops-retrieval-replay.mjs --input ~/.eliza/trajectories \\
 *     --output ~/.eliza/trajectories-replay
 *
 * The script only touches LifeOpsBench trajectories (those with a
 * `lifeops_bench` task_id embedded in the user message) so noise from
 * unrelated runs stays out of the recall stats.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildActionCatalog } from "../packages/core/src/runtime/action-catalog.ts";
import { retrieveActions } from "../packages/core/src/runtime/action-retrieval.ts";

const FILTERED_TOOL_NAMES = new Set([
  "BENCHMARK_ACTION",
  "NONE",
  "REPLY",
  "IGNORE",
  "PAGE_DELEGATE",
]);

function parseArgs(argv) {
  const out = { input: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--output") out.output = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function defaultStateDir() {
  // Env wins (MILADY_STATE_DIR / ELIZA_STATE_DIR), then check both legacy
  // and current default dirs so the script works in mixed environments.
  const envDir =
    process.env.MILADY_STATE_DIR?.trim() ||
    process.env.ELIZA_STATE_DIR?.trim();
  if (envDir) return envDir;
  const milady = path.join(os.homedir(), ".milady");
  const eliza = path.join(os.homedir(), ".eliza");
  if (fs.existsSync(path.join(milady, "trajectories"))) return milady;
  return eliza;
}

const stateDir = defaultStateDir();
const inputRoot = args.input ?? path.join(stateDir, "trajectories");
const outputRoot =
  args.output ?? path.join(stateDir, "trajectories-replay");

if (!fs.existsSync(inputRoot)) {
  console.error(`[replay] input directory not found: ${inputRoot}`);
  process.exit(1);
}

fs.mkdirSync(outputRoot, { recursive: true });

function listJson(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && p.endsWith(".json")) out.push(p);
    }
  }
  return out;
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse the lifeops_bench tools manifest out of a user-message text.
 * The bench harness embeds the full tool catalog as a "BENCHMARK CONTEXT"
 * JSON blob below the user instruction.
 *
 * Returns the array of `{ type: "function", function: {...} }` entries or
 * null when the message is not a benchmark message.
 */
function extractToolsManifest(messageText) {
  if (typeof messageText !== "string") return null;
  const marker = messageText.indexOf("BENCHMARK CONTEXT");
  if (marker < 0) return null;
  const braceStart = messageText.indexOf("{", marker);
  if (braceStart < 0) return null;
  // Find the matching closing brace by walking forward.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = braceStart; i < messageText.length; i += 1) {
    const ch = messageText[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const blob = messageText.slice(braceStart, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.tools)) return null;
  return parsed.tools;
}

/**
 * Strip the BENCHMARK CONTEXT blob from the user message so the retrieval
 * query operates on the user's actual intent, not the embedded tool dump.
 */
function stripBenchmarkContext(messageText) {
  if (typeof messageText !== "string") return messageText ?? "";
  const idx = messageText.indexOf("BENCHMARK CONTEXT");
  if (idx < 0) return messageText;
  return messageText.slice(0, idx).trim();
}

/** Build a runtime-shaped action list from the bench tools manifest. */
function toolsManifestToActions(tools) {
  const actions = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function;
    if (!fn || typeof fn !== "object") continue;
    const name = typeof fn.name === "string" ? fn.name : null;
    if (!name) continue;
    const description =
      typeof fn.description === "string" ? fn.description : "";
    actions.push({ name, description });
  }
  return actions;
}

/**
 * Collect the names of executed tool stages following each toolSearch.
 * LifeOpsBench wraps the planner's real call inside a `BENCHMARK_ACTION`
 * shim — when we see that, unwrap to the underlying `tool_name` so the
 * ground truth reflects the action the retriever actually needed to
 * surface (e.g. `CALENDAR_PROPOSE_TIMES`, not `BENCHMARK_ACTION`).
 */
function collectExecutedToolNames(stages, fromIndex) {
  const out = [];
  const seen = new Set();
  for (let i = fromIndex; i < stages.length; i += 1) {
    const s = stages[i];
    // From the immediately-following planner stages, also recover any
    // tool_calls the model emitted (BENCHMARK_ACTION wraps the real call
    // in the args, so we have to look there for the actionable name).
    if (s?.kind === "planner") {
      const calls = Array.isArray(s.model?.toolCalls) ? s.model.toolCalls : [];
      for (const call of calls) {
        const wrappedName =
          typeof call?.name === "string" ? call.name.toUpperCase() : null;
        if (!wrappedName) continue;
        if (wrappedName === "BENCHMARK_ACTION") {
          const inner = call.args?.tool_name;
          if (typeof inner === "string") {
            const innerName = inner.toUpperCase();
            if (!FILTERED_TOOL_NAMES.has(innerName) && !seen.has(innerName)) {
              seen.add(innerName);
              out.push(innerName);
            }
          }
          continue;
        }
        if (!FILTERED_TOOL_NAMES.has(wrappedName) && !seen.has(wrappedName)) {
          seen.add(wrappedName);
          out.push(wrappedName);
        }
      }
      continue;
    }
    if (s?.kind !== "tool") continue;
    const name =
      typeof s.tool?.name === "string" ? s.tool.name.toUpperCase() : null;
    if (!name) continue;
    if (FILTERED_TOOL_NAMES.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const stats = {
  trajectoriesScanned: 0,
  trajectoriesWritten: 0,
  trajectoriesSkippedNoBench: 0,
  trajectoriesSkippedNoToolSearch: 0,
  toolSearchAugmented: 0,
  toolSearchSkippedNoCorrect: 0,
};

const inputFiles = listJson(inputRoot);
console.log(`[replay] scanning ${inputFiles.length} input files…`);

for (const file of inputFiles) {
  stats.trajectoriesScanned += 1;
  const traj = safeReadJson(file);
  if (!traj || !Array.isArray(traj.stages)) continue;

  // Only LifeOps benchmark trajectories carry the embedded tools blob we can
  // reconstruct the catalog from.
  const rootText = traj.rootMessage?.text;
  const isLifeOps =
    typeof rootText === "string" && rootText.includes("lifeops_bench");
  if (!isLifeOps) {
    stats.trajectoriesSkippedNoBench += 1;
    continue;
  }

  let toolSearchCount = 0;
  for (let i = 0; i < traj.stages.length; i += 1) {
    const stage = traj.stages[i];
    if (stage?.kind !== "toolSearch") continue;
    toolSearchCount += 1;

    const ts = stage.toolSearch;
    if (!ts || typeof ts !== "object") continue;

    const queryRaw =
      typeof ts.query?.text === "string" ? ts.query.text : rootText;
    const tools = extractToolsManifest(queryRaw) ?? extractToolsManifest(rootText);
    if (!tools || tools.length === 0) continue;

    const actions = toolsManifestToActions(tools);
    if (actions.length === 0) continue;

    const correctActions = collectExecutedToolNames(traj.stages, i + 1);
    if (correctActions.length === 0) {
      stats.toolSearchSkippedNoCorrect += 1;
      continue;
    }

    const messageText = stripBenchmarkContext(queryRaw) || queryRaw;
    const catalog = buildActionCatalog(actions);
    const response = retrieveActions({
      catalog,
      messageText,
      candidateActions: ts.query?.candidateActions,
      parentActionHints: ts.query?.parentActionHints,
      measurementMode: true,
    });

    if (response.measurement) {
      ts.perStageScores = response.measurement.perStageScores;
      ts.fusedTopK = response.measurement.fusedTopK;
      ts.correctActions = correctActions;
      stats.toolSearchAugmented += 1;
    }
  }

  if (toolSearchCount === 0) {
    stats.trajectoriesSkippedNoToolSearch += 1;
    continue;
  }

  const relPath = path.relative(inputRoot, file);
  const outPath = path.join(outputRoot, relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(traj, null, 2));
  stats.trajectoriesWritten += 1;
}

console.log(`[replay] done.`);
console.log(`[replay] trajectoriesScanned       : ${stats.trajectoriesScanned}`);
console.log(`[replay] trajectoriesWritten       : ${stats.trajectoriesWritten}`);
console.log(`[replay] skipped (not lifeops_bench): ${stats.trajectoriesSkippedNoBench}`);
console.log(`[replay] skipped (no toolSearch)    : ${stats.trajectoriesSkippedNoToolSearch}`);
console.log(`[replay] toolSearch augmented       : ${stats.toolSearchAugmented}`);
console.log(`[replay] toolSearch skipped (no correct): ${stats.toolSearchSkippedNoCorrect}`);
console.log(`[replay] output: ${outputRoot}`);
