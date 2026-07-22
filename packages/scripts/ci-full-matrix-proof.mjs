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
 *      `workflow_call`, pass its dedicated concurrency scope, and queue
 *      consecutive exhaustive runs. Every reusable workflow must consume that
 *      scope and keep schedule/dispatch/workflow-call events non-cancelling. A
 *      dropped `uses:`, shared standalone group, or cancelling reusable lane
 *      silently strips platform coverage from the exhaustive matrix and fails.
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

export function parseArgs(argv) {
  const options = {
    planFile: null,
    manifest: resolve(here, "ci-lane-manifest.json"),
    // GitHub injects this only for workflow steps; local proof runs omit it.
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: CI-owned output path.
    summary: process.env.GITHUB_STEP_SUMMARY || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan-file") {
      i += 1;
      options.planFile = argv[i];
    } else if (arg === "--manifest") {
      i += 1;
      options.manifest = argv[i];
    } else if (arg === "--summary") {
      i += 1;
      options.summary = argv[i];
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
  const start = lines.indexOf(header);
  if (start < 0) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) && !/^ {3}/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function findJobBlockUsing(workflowText, usesRef) {
  for (const jobKey of extractWorkflowJobKeys(workflowText)) {
    const block = extractJobBlock(workflowText, jobKey);
    if (block?.includes(`uses: ${usesRef}`)) return block;
  }
  return null;
}

function extractWorkflowCallBlock(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.indexOf("  workflow_call:");
  if (start < 0) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function extractWorkflowEventBlock(workflowText, eventName) {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.indexOf(`  ${eventName}:`);
  if (start < 0) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function extractConcurrencyValue(workflowText, key) {
  const match = workflowText.match(
    new RegExp(`^\\s{2}${key}:\\s*(.+?)\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

function normalizeGitHubExpression(body) {
  return body.replace(/\s+/g, "").replaceAll('"', "'");
}

function githubExpressionBodies(value) {
  if (value === null) return [];
  return [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) =>
    normalizeGitHubExpression(match[1]),
  );
}

function normalizedGitHubTemplate(value) {
  if (value === null) return null;
  return value.replace(
    /\$\{\{([\s\S]*?)\}\}/g,
    (_match, body) => `\${{${normalizeGitHubExpression(body)}}}`,
  );
}

function extractJobValue(jobBlock, key) {
  if (jobBlock === null) return null;
  const match = jobBlock.match(new RegExp(`^ {4}${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function cancellationEvents(expression) {
  if (expression === null || expression === "false") return new Set();
  if (expression === "true") return new Set(["*"]);

  const body = expression
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .trim();
  if (body.includes("!=")) return new Set(["*"]);

  const events = new Set();
  const comparison = /github\.event_name\s*==\s*['"]([^'"]+)['"]/g;
  for (const match of body.matchAll(comparison)) events.add(match[1]);
  const residual = body.replace(comparison, "").replace(/\|\||&&|[()\s]/g, "");
  return residual.length === 0 && events.size > 0 ? events : new Set(["*"]);
}

function cancelsEvent(expression, eventName) {
  const events = cancellationEvents(expression);
  return events.has("*") || events.has(eventName);
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

// GitHub's default concurrency mode retains only one pending run; queue:max is
// therefore part of the exhaustive contract, not an optimization. Reusable
// workflows then consume an exact caller-scope expression so standalone events
// cannot collapse into the exhaustive namespace through a truthy-expression
// lookalike.
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

  const scope = manifest.exhaustiveConcurrencyScope;
  if (typeof scope !== "string" || scope.length === 0) {
    violations.push(
      "missing exhaustive concurrency scope: exhaustiveConcurrencyScope must name the reusable caller namespace",
    );
  }
  const orchestratorGroup = extractConcurrencyValue(orchestratorText, "group");
  const orchestratorCancel = extractConcurrencyValue(
    orchestratorText,
    "cancel-in-progress",
  );
  const orchestratorQueue = extractConcurrencyValue(orchestratorText, "queue");
  const expectedOrchestratorGroup = `${scope}-\${{github.ref}}`;
  if (
    normalizedGitHubTemplate(orchestratorGroup) !== expectedOrchestratorGroup
  ) {
    violations.push(
      `exhaustive orchestrator concurrency drift: ${manifest.exhaustiveOrchestrator} must use group ${scope}-\${{ github.ref }}`,
    );
  }
  if (orchestratorQueue !== "max") {
    violations.push(
      `consecutive exhaustive runs can replace pending coverage: ${manifest.exhaustiveOrchestrator} must set queue: max`,
    );
  }
  if (orchestratorCancel !== "false") {
    violations.push(
      `consecutive exhaustive runs can cancel: ${manifest.exhaustiveOrchestrator} must set cancel-in-progress: false`,
    );
  }

  for (const reusable of manifest.reusableWorkflows) {
    const basename = reusable.workflow.split("/").pop();
    const usesRef = `./.github/workflows/${basename}`;
    const callerJob = findJobBlockUsing(orchestratorText, usesRef);
    if (callerJob === null) {
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
    let unsafe = false;
    if (!callerJob.includes(`      concurrency_scope: ${scope}`)) {
      violations.push(
        `reusable caller shares standalone concurrency: ${usesRef} is not passed concurrency_scope: ${scope}`,
      );
      unsafe = true;
    }
    let reusableText;
    let workflowCallBlock;
    try {
      reusableText = readFileSync(resolve(repoRoot, reusable.workflow), "utf8");
      workflowCallBlock = extractWorkflowCallBlock(reusableText);
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
    if (workflowCallBlock === null) {
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
    if (
      !workflowCallBlock.includes("    inputs:") ||
      !workflowCallBlock.includes("      concurrency_scope:") ||
      !workflowCallBlock.includes("        type: string") ||
      !workflowCallBlock.includes("        default: standalone")
    ) {
      violations.push(
        `reusable workflow ignores caller concurrency scope: ${reusable.workflow} must declare string workflow_call input concurrency_scope with default standalone`,
      );
      unsafe = true;
    }

    const group = extractConcurrencyValue(reusableText, "group");
    const groupExpressions = githubExpressionBodies(group);
    if (!groupExpressions.includes("inputs.concurrency_scope||'standalone'")) {
      violations.push(
        `reusable concurrency collision: ${reusable.workflow} must namespace its group with the exact inputs.concurrency_scope || 'standalone' expression`,
      );
      unsafe = true;
    }

    const cancelExpression = extractConcurrencyValue(
      reusableText,
      "cancel-in-progress",
    );
    const cancellingExhaustiveEvents = [
      "schedule",
      "workflow_dispatch",
      "workflow_call",
    ].filter((eventName) => cancelsEvent(cancelExpression, eventName));
    if (cancellingExhaustiveEvents.length > 0) {
      violations.push(
        `reusable workflow can cancel exhaustive coverage: ${reusable.workflow} cancels ${cancellingExhaustiveEvents.join(", ")}; only obsolete standalone PR/push work may cancel`,
      );
      unsafe = true;
    }
    laneReport.push({
      lane: basename,
      name: reusable.name,
      status: unsafe ? "CONCURRENCY-UNSAFE" : "OK",
    });
  }
}

// Develop pushes intentionally supersede obsolete tips. Schedule and manual
// runs use per-run namespaces so they cannot be victims of a later push, and a
// quiet latest tip must retain one fail-closed aggregate result.
function checkPostMergeSignal(manifest, violations, laneReport) {
  const contract = manifest.postMergeSignal;
  if (!contract) return;

  const workflowText = readFileSync(
    resolve(repoRoot, manifest.workflow),
    "utf8",
  );
  const pushBlock = extractWorkflowEventBlock(workflowText, "push");
  const group = extractConcurrencyValue(workflowText, "group");
  const cancelExpression = extractConcurrencyValue(
    workflowText,
    "cancel-in-progress",
  );
  const aggregate = extractJobBlock(workflowText, contract.aggregateJob);
  const aggregateIf = extractJobValue(aggregate, "if");
  let unsafe = false;

  if (!pushBlock?.includes(contract.branch)) {
    violations.push(
      `post-merge signal missing: ${manifest.workflow} does not run on pushes to ${contract.branch}`,
    );
    unsafe = true;
  }
  const expectedGroup = `test-\${{github.event_name=='push'&&github.ref||format('{0}-{1}',github.event_name,github.run_id)}}`;
  if (normalizedGitHubTemplate(group) !== expectedGroup) {
    violations.push(
      `post-merge concurrency drift: ${manifest.workflow} must share github.ref only across pushes and isolate schedule/dispatch by run id`,
    );
    unsafe = true;
  }
  const cancelBodies = githubExpressionBodies(cancelExpression);
  if (
    cancelBodies.length !== 1 ||
    cancelBodies[0] !== "github.event_name=='push'"
  ) {
    violations.push(
      `post-merge cancellation drift: ${manifest.workflow} must cancel only obsolete push tips`,
    );
    unsafe = true;
  }
  const aggregateIfBodies = githubExpressionBodies(aggregateIf);
  if (
    aggregate === null ||
    aggregateIfBodies.length !== 1 ||
    aggregateIfBodies[0] !== "!cancelled()&&always()"
  ) {
    violations.push(
      `canonical post-merge result missing: ${contract.aggregateJob} must run fail-closed with always() and !cancelled()`,
    );
    unsafe = true;
  }
  laneReport.push({
    lane: `post-merge:${contract.aggregateJob}`,
    name: "Canonical quiescent develop result",
    status: unsafe ? "CONCURRENCY-UNSAFE" : "OK",
  });
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

export function writeSummary(summaryPath, laneReport, floorReport, violations) {
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
  checkPostMergeSignal(manifest, violations, laneReport);
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
