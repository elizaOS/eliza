#!/usr/bin/env node
/**
 * Proof job for the exhaustive develop lane (#12342). Fails loudly when the
 * committed lane manifest and the real workflow/test-plan drift apart, so the
 * scheduled full-matrix run cannot silently drop coverage or report vacuous
 * green.
 *
 * It cross-checks four independent sources of truth:
 *   1. `packages/scripts/ci-lane-manifest.json` — the committed expectation.
 *   2. `.github/workflows/test.yml` — every manifest lane must exist as a job
 *      and must not be gated so it can never run on the exhaustive (non-PR)
 *      event, which would turn a "required" lane into a permanent skip.
 *   3. `.github/workflows/develop-exhaustive.yml` — the scheduled orchestrator
 *      must still invoke every manifest `reusableWorkflows` lane via
 *      `workflow_call`, and each of those workflows must still declare a
 *      `workflow_call` trigger without unconditional concurrency cancellation.
 *      A dropped `uses:`, removed trigger, or reusable lane that can cancel a
 *      prior scheduled run silently strips platform coverage (Windows/mobile/
 *      scenario/UI/desktop) from the exhaustive matrix and fails the job.
 *   4. `run-all-tests.mjs --plan=json` — the discovered task plan must clear the
 *      manifest floors (total tasks/packages, per-script-lane presence, and the
 *      set of required core packages). A pointed-at-a-nonexistent-glob lane or a
 *      deleted core package collapses one of these and fails the job.
 *
 * Usage:
 *   node packages/scripts/ci-full-matrix-proof.mjs [--plan-file <path>]
 *                                                   [--manifest <path>]
 *                                                   [--summary <path>]
 *
 * `--plan-file` short-circuits the plan discovery (used by tests and by CI when
 * the plan was captured in an earlier step). Without it the script spawns the
 * runner in `--plan=json` mode itself. Exit code 0 = every lane accounted for;
 * non-zero = at least one drift, with every violation printed (not just the
 * first) and mirrored into the GitHub step summary when `--summary` is given.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function parseArgs(argv) {
  const options = {
    planFile: null,
    manifest: resolve(here, "ci-lane-manifest.json"),
    summary: process.env.GITHUB_STEP_SUMMARY || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan-file") {
      options.planFile = argv[(i += 1)];
    } else if (arg === "--manifest") {
      options.manifest = argv[(i += 1)];
    } else if (arg === "--summary") {
      options.summary = argv[(i += 1)];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (
      (arg === "--plan-file" || arg === "--manifest" || arg === "--summary") &&
      argv[i] === undefined
    ) {
      throw new Error(`${arg} requires a value`);
    }
  }
  return options;
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.workflowLanes)) {
    throw new Error(`${manifestPath}: workflowLanes must be an array`);
  }
  if (!manifest.planFloors || typeof manifest.planFloors !== "object") {
    throw new Error(`${manifestPath}: planFloors must be an object`);
  }
  return manifest;
}

function loadPlan({ planFile }) {
  if (planFile) {
    return JSON.parse(readFileSync(planFile, "utf8"));
  }
  // Redirect the runner's stdout to a file rather than capturing it through a
  // pipe. The plan JSON is >64KB and run-all-tests calls process.exit(0) right
  // after writing it, which can truncate a piped stdout mid-flush; a file
  // descriptor is flushed on close, so this is the only lossless capture. It
  // also mirrors how the CI workflow invokes the runner (`> plan.json`).
  const runner = resolve(here, "run-all-tests.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ci-full-matrix-proof-"));
  const planPath = join(dir, "plan.json");
  const fd = openSync(planPath, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [runner, "--plan=json"], {
      cwd: repoRoot,
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    closeSync(fd);
  }
  try {
    if (result.status !== 0) {
      throw new Error(
        `run-all-tests.mjs --plan=json exited ${result.status}: ${
          result.stderr ? result.stderr.toString() : ""
        }`,
      );
    }
    return JSON.parse(readFileSync(planPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Locate a top-level job block in the workflow YAML by its key. Returns the raw
// text of that job (up to the next top-level 2-space-indented key) or null.
// A structural regex read keeps this dependency-free; test.yml is hand-authored
// with the conventional two-space job indentation this relies on.
function extractJobBlock(workflowText, jobKey) {
  const lines = workflowText.split(/\r?\n/);
  const header = `  ${jobKey}:`;
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) && !/^ {3}/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function extractWorkflowJobKeys(workflowText) {
  const keys = [];
  for (const line of workflowText.split(/\r?\n/)) {
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function parseNeeds(jobBlock) {
  const lines = jobBlock.split(/\r?\n/);
  const needs = new Set();
  const needsLineIndex = lines.findIndex((line) => /^ {4}needs:\s*/.test(line));
  if (needsLineIndex < 0) return needs;

  const inline = lines[needsLineIndex].replace(/^ {4}needs:\s*/, "").trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    for (const value of inline
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)) {
      needs.add(value);
    }
    return needs;
  }
  if (inline) {
    needs.add(inline.replace(/^['"]|['"]$/g, ""));
    return needs;
  }

  for (let i = needsLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {4}\S/.test(line)) break;
    const match = line.match(/^ {6}-\s*([A-Za-z0-9_-]+)\s*$/);
    if (match) needs.add(match[1]);
  }
  return needs;
}

function buildNeedsGraph(workflowText) {
  const graph = new Map();
  for (const jobKey of extractWorkflowJobKeys(workflowText)) {
    const block = extractJobBlock(workflowText, jobKey);
    if (block) graph.set(jobKey, parseNeeds(block));
  }
  return graph;
}

function collectTransitiveNeeds(graph, root) {
  const visited = new Set();
  const stack = [...(graph.get(root) ?? [])];
  while (stack.length > 0) {
    const job = stack.pop();
    if (!job || visited.has(job)) continue;
    visited.add(job);
    for (const next of graph.get(job) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return visited;
}

// A lane job is "exhaustively runnable" when its `if:` does not force a skip on
// non-PR events. The repo convention gates PR runs with
// `github.event_name != 'pull_request' || needs.changes.outputs.<x> == 'true'`,
// which is TRUE on schedule/push/merge_group. A job with no `if:` always runs.
// The only failure we can catch statically is an `if:` that hard-pins the job to
// pull_request only (so the exhaustive event would skip it).
function laneRunsOnExhaustiveEvent(jobBlock) {
  const ifMatch = jobBlock.match(/^\s{4}if:\s*(.+)$/m);
  if (!ifMatch) return true;
  const condition = ifMatch[1].trim();
  // Hard PR-only pin: e.g. `if: github.event_name == 'pull_request'` with no
  // non-PR escape. If the condition mentions pull_request equality but never the
  // inequality/other-event escape, treat it as PR-pinned.
  const pinsToPullRequest =
    /github\.event_name\s*==\s*'pull_request'/.test(condition) &&
    !/github\.event_name\s*!=\s*'pull_request'/.test(condition) &&
    !/'(push|schedule|merge_group|workflow_dispatch)'/.test(condition);
  return !pinsToPullRequest;
}

function checkWorkflowLanes(manifest, violations, laneReport) {
  const workflowPath = resolve(repoRoot, manifest.workflow);
  const workflowText = readFileSync(workflowPath, "utf8");

  for (const lane of manifest.workflowLanes) {
    const jobBlock = extractJobBlock(workflowText, lane.job);
    if (jobBlock === null) {
      violations.push(
        `missing lane: job "${lane.job}" (${lane.name}) not found in ${manifest.workflow}`,
      );
      laneReport.push({ lane: lane.job, name: lane.name, status: "MISSING" });
      continue;
    }
    if (!laneRunsOnExhaustiveEvent(jobBlock)) {
      violations.push(
        `unexpectedly skipped lane: job "${lane.job}" (${lane.name}) is pinned to pull_request only and cannot run on the exhaustive scheduled event`,
      );
      laneReport.push({ lane: lane.job, name: lane.name, status: "PR-ONLY" });
      continue;
    }
    laneReport.push({ lane: lane.job, name: lane.name, status: "OK" });
  }

  // The aggregate status job must exist and must `needs:` every workflow lane so
  // a lane cannot silently drop out of the required check.
  if (manifest.aggregateStatusJob) {
    const aggregate = extractJobBlock(
      workflowText,
      manifest.aggregateStatusJob,
    );
    if (aggregate === null) {
      violations.push(
        `missing aggregate: job "${manifest.aggregateStatusJob}" not found in ${manifest.workflow}`,
      );
    } else {
      const graph = buildNeedsGraph(workflowText);
      const reachable = collectTransitiveNeeds(
        graph,
        manifest.aggregateStatusJob,
      );
      for (const lane of manifest.workflowLanes) {
        if (!reachable.has(lane.job)) {
          violations.push(
            `aggregate drift: job "${manifest.aggregateStatusJob}" does not need lane "${lane.job}" (${lane.name}) directly or through an aggregate dependency`,
          );
        }
      }
    }
  }
}

// The scheduled exhaustive orchestrator (develop-exhaustive.yml) must keep
// invoking every platform lane the manifest lists, and each of those workflows
// must still declare a `workflow_call` trigger — otherwise the orchestrator
// silently drops that lane's coverage. Both halves are checked statically so a
// dropped `uses:` or a removed trigger fails without waiting for the run.
function checkReusableWorkflows(manifest, violations, laneReport) {
  if (
    !manifest.exhaustiveOrchestrator ||
    !Array.isArray(manifest.reusableWorkflows)
  ) {
    return;
  }
  const orchestratorPath = resolve(repoRoot, manifest.exhaustiveOrchestrator);
  let orchestratorText;
  try {
    orchestratorText = readFileSync(orchestratorPath, "utf8");
  } catch {
    violations.push(
      `missing exhaustive orchestrator: ${manifest.exhaustiveOrchestrator} not found`,
    );
    return;
  }

  for (const reusable of manifest.reusableWorkflows) {
    const basename = reusable.workflow.split("/").pop();
    const usesRef = `./.github/workflows/${basename}`;
    if (!orchestratorText.includes(`uses: ${usesRef}`)) {
      violations.push(
        `missing reusable lane: ${manifest.exhaustiveOrchestrator} does not invoke ${usesRef} (${reusable.name})`,
      );
      laneReport.push({
        lane: basename,
        name: reusable.name,
        status: "NOT-WIRED",
      });
      continue;
    }
    let reusableText;
    let declaresWorkflowCall = false;
    try {
      reusableText = readFileSync(resolve(repoRoot, reusable.workflow), "utf8");
      declaresWorkflowCall = /^\s{2}workflow_call:/m.test(reusableText);
    } catch {
      violations.push(
        `missing reusable workflow: ${reusable.workflow} (${reusable.name}) not found`,
      );
      laneReport.push({
        lane: basename,
        name: reusable.name,
        status: "MISSING",
      });
      continue;
    }
    if (!declaresWorkflowCall) {
      violations.push(
        `reusable workflow not callable: ${reusable.workflow} does not declare a workflow_call trigger, so ${manifest.exhaustiveOrchestrator} cannot invoke it`,
      );
      laneReport.push({
        lane: basename,
        name: reusable.name,
        status: "NO-CALL",
      });
      continue;
    }
    if (/^\s{2}cancel-in-progress:\s*true\s*$/m.test(reusableText)) {
      violations.push(
        `reusable workflow can cancel scheduled coverage: ${reusable.workflow} has unconditional cancel-in-progress: true; gate cancellation to pull_request so ${manifest.exhaustiveOrchestrator} remains uncancellable`,
      );
      laneReport.push({
        lane: basename,
        name: reusable.name,
        status: "CANCELS",
      });
      continue;
    }
    laneReport.push({ lane: basename, name: reusable.name, status: "OK" });
  }
}

function checkPlanFloors(manifest, plan, violations, floorReport) {
  const floors = manifest.planFloors;
  const summary = plan.summary || {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];

  const taskCount = summary.taskCount ?? tasks.length;
  const packageCount =
    summary.packageCount ?? new Set(tasks.map((t) => t.packageName)).size;

  floorReport.push({
    metric: "taskCount",
    value: taskCount,
    floor: floors.minTaskCount,
  });
  if (
    typeof floors.minTaskCount === "number" &&
    taskCount < floors.minTaskCount
  ) {
    violations.push(
      `plan floor: taskCount ${taskCount} < minTaskCount ${floors.minTaskCount} (a lane matched no tests?)`,
    );
  }

  floorReport.push({
    metric: "packageCount",
    value: packageCount,
    floor: floors.minPackageCount,
  });
  if (
    typeof floors.minPackageCount === "number" &&
    packageCount < floors.minPackageCount
  ) {
    violations.push(
      `plan floor: packageCount ${packageCount} < minPackageCount ${floors.minPackageCount}`,
    );
  }

  if (typeof floors.minPluginTaskCount === "number") {
    const pluginTasks = tasks.filter((t) =>
      String(t.relativeDir || "").startsWith("plugins/"),
    ).length;
    floorReport.push({
      metric: "pluginTaskCount",
      value: pluginTasks,
      floor: floors.minPluginTaskCount,
    });
    if (pluginTasks < floors.minPluginTaskCount) {
      violations.push(
        `plan floor: pluginTaskCount ${pluginTasks} < minPluginTaskCount ${floors.minPluginTaskCount}`,
      );
    }
  }

  const presentPackages = new Set(tasks.map((t) => t.packageName));
  for (const required of floors.requiredPackages || []) {
    if (!presentPackages.has(required)) {
      violations.push(
        `plan floor: required package "${required}" has no discovered test task (deleted, renamed, or its test script vanished)`,
      );
    }
  }

  const byScript = summary.byScript || {};
  for (const laneScript of floors.nonEmptyScriptLanes || []) {
    const count = byScript[laneScript] ?? 0;
    floorReport.push({
      metric: `script:${laneScript}`,
      value: count,
      floor: 1,
    });
    if (count < 1) {
      violations.push(
        `plan floor: script lane "${laneScript}" collected zero tasks (whole ${laneScript} lane vanished)`,
      );
    }
  }
}

function writeSummary(summaryPath, laneReport, floorReport, violations) {
  if (!summaryPath) return;
  const lines = [];
  lines.push("## Exhaustive lane matrix proof");
  lines.push("");
  lines.push("### Workflow lanes");
  lines.push("");
  lines.push("| Lane (job) | Name | Status |");
  lines.push("| --- | --- | --- |");
  for (const row of laneReport) {
    lines.push(`| \`${row.lane}\` | ${row.name} | ${row.status} |`);
  }
  lines.push("");
  lines.push("### Plan floors");
  lines.push("");
  lines.push("| Metric | Value | Floor |");
  lines.push("| --- | --- | --- |");
  for (const row of floorReport) {
    lines.push(`| ${row.metric} | ${row.value} | ${row.floor} |`);
  }
  lines.push("");
  if (violations.length === 0) {
    lines.push(
      "**Result: PASS** — every expected lane is present and non-empty.",
    );
  } else {
    lines.push(`**Result: FAIL** — ${violations.length} violation(s):`);
    lines.push("");
    for (const violation of violations) {
      lines.push(`- ${violation}`);
    }
  }
  lines.push("");
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

export function runProof(options) {
  const manifest = loadManifest(options.manifest);
  const plan = loadPlan(options);
  const violations = [];
  const laneReport = [];
  const floorReport = [];

  checkWorkflowLanes(manifest, violations, laneReport);
  checkReusableWorkflows(manifest, violations, laneReport);
  checkPlanFloors(manifest, plan, violations, floorReport);

  return { manifest, plan, violations, laneReport, floorReport };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ci-full-matrix-proof] ERROR ${error.message}`);
    process.exit(2);
  }

  const { violations, laneReport, floorReport } = runProof(options);

  for (const row of laneReport) {
    console.log(`[ci-full-matrix-proof] lane ${row.lane} — ${row.status}`);
  }
  for (const row of floorReport) {
    console.log(
      `[ci-full-matrix-proof] floor ${row.metric}=${row.value} (min ${row.floor})`,
    );
  }

  writeSummary(options.summary, laneReport, floorReport, violations);

  if (violations.length > 0) {
    console.error(
      `[ci-full-matrix-proof] FAIL ${violations.length} violation(s):`,
    );
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log("[ci-full-matrix-proof] PASS every expected lane accounted for");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
