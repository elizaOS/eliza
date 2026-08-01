#!/usr/bin/env node
/**
 * Proves that exhaustive develop workflows remain connected and non-cancelling.
 * The captured test plan is checked against its live package manifests, unique
 * task identities, and exact derived summaries, so repository growth or shrink
 * never requires a hand-maintained numeric baseline.
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
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";

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
  if (manifest.planContract !== "workspace-package-scripts-v1") {
    throw new Error(
      `${manifestPath}: planContract must be workspace-package-scripts-v1`,
    );
  }
  if (Object.hasOwn(manifest, "planFloors")) {
    throw new Error(`${manifestPath}: planFloors is obsolete`);
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
    result = spawnSync(
      process.execPath,
      [runner, "--plan=json", "--require-work"],
      {
        cwd: repoRoot,
        stdio: ["ignore", fd, "pipe"],
      },
    );
  } finally {
    closeSync(fd);
  }
  try {
    if (result.status !== 0) {
      throw new Error(
        `run-all-tests.mjs --plan=json --require-work exited ${result.status}: ${
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
    // error-policy:J3 a missing manifest-selected workflow is an explicit violation.
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
      // error-policy:J3 a missing manifest-selected workflow is an explicit violation.
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

function incrementCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCountRecord(counts) {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalCountRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, count]) =>
        key.length === 0 || !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    return null;
  }
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

function readTaskManifest(sourceRoot, relativeDir, cache) {
  if (cache.has(relativeDir)) return cache.get(relativeDir);
  const manifestPath = `${relativeDir}/package.json`;
  const { absolute } = assertContainedRegularFile(
    sourceRoot,
    manifestPath,
    `plan task manifest ${manifestPath}`,
  );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    // error-policy:J2 bind invalid JSON to the source manifest named by the task.
    throw new Error(`invalid plan task manifest ${manifestPath}`, {
      cause: error,
    });
  }
  cache.set(relativeDir, manifest);
  return manifest;
}

function checkExactSummaryValue(summary, field, expected, violations) {
  if (summary[field] !== expected) {
    violations.push(
      `plan summary contract: ${field}=${JSON.stringify(summary[field])} does not equal derived ${JSON.stringify(expected)}`,
    );
  }
}

function checkPlanContract(plan, violations, planReport, sourceRoot) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    violations.push("plan source contract: plan root must be an object");
    return;
  }
  const sourceViolationStart = violations.length;
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (!Array.isArray(plan.tasks)) {
    violations.push("plan source contract: tasks must be an array");
  }
  if (tasks.length === 0) {
    violations.push("plan source contract: selected zero runnable tasks");
  }

  const manifestCache = new Map();
  const taskIdentities = [];
  const labels = [];
  let sourceBackedTasks = 0;
  for (const [index, task] of tasks.entries()) {
    try {
      if (task === null || typeof task !== "object" || Array.isArray(task)) {
        throw new Error("task must be an object");
      }
      const { packageName, relativeDir, scriptName, label, parallelSafe } =
        task;
      if (
        typeof packageName !== "string" ||
        packageName.length === 0 ||
        typeof scriptName !== "string" ||
        scriptName.length === 0 ||
        typeof label !== "string" ||
        label.length === 0 ||
        typeof parallelSafe !== "boolean"
      ) {
        throw new Error(
          "packageName, scriptName, label, and parallelSafe must be typed",
        );
      }
      const canonicalDir = normalizeGitRepositoryPath(
        relativeDir,
        `plan task[${index}] relativeDir`,
      );
      const manifest = readTaskManifest(
        sourceRoot,
        canonicalDir,
        manifestCache,
      );
      const manifestName =
        typeof manifest.name === "string" && manifest.name.length > 0
          ? manifest.name
          : canonicalDir;
      if (packageName !== manifestName) {
        throw new Error(
          `packageName ${packageName} does not match manifest name ${manifestName}`,
        );
      }
      const command = manifest.scripts?.[scriptName];
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error(
          `${canonicalDir}/package.json has no runnable ${scriptName} script`,
        );
      }
      const expectedLabel = `${packageName} (${canonicalDir})#${scriptName}`;
      if (label !== expectedLabel) {
        throw new Error(`label ${label} does not equal ${expectedLabel}`);
      }
      taskIdentities.push(`${canonicalDir}#${scriptName}`);
      labels.push(label);
      sourceBackedTasks += 1;
    } catch (error) {
      // error-policy:J3 captured plans are untrusted structured input.
      violations.push(
        `plan source contract: task[${index}] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    assertUniqueRepositoryIdentities(
      taskIdentities,
      "duplicate plan task identity",
    );
    assertUniqueRepositoryIdentities(labels, "duplicate plan task label");
  } catch (error) {
    // error-policy:J3 identity collisions invalidate the captured plan.
    violations.push(
      `plan source contract: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sourceContractValid = violations.length === sourceViolationStart;

  const summary = plan.summary;
  const summaryViolationStart = violations.length;
  if (
    summary === null ||
    typeof summary !== "object" ||
    Array.isArray(summary)
  ) {
    violations.push("plan summary contract: summary must be an object");
  } else {
    const packageNames = new Set();
    const byScript = new Map();
    const byPackage = new Map();
    let parallelSafeTaskCount = 0;
    for (const task of tasks) {
      if (typeof task?.packageName === "string") {
        packageNames.add(task.packageName);
        incrementCount(byPackage, task.packageName);
      }
      if (typeof task?.scriptName === "string") {
        incrementCount(byScript, task.scriptName);
      }
      if (task?.parallelSafe === true) parallelSafeTaskCount += 1;
    }
    const cloudStep = plan.cloudStep !== null && plan.cloudStep !== undefined;
    checkExactSummaryValue(summary, "taskCount", tasks.length, violations);
    checkExactSummaryValue(
      summary,
      "packageCount",
      packageNames.size,
      violations,
    );
    checkExactSummaryValue(
      summary,
      "parallelSafeTaskCount",
      parallelSafeTaskCount,
      violations,
    );
    checkExactSummaryValue(
      summary,
      "serialTaskCount",
      tasks.length - parallelSafeTaskCount,
      violations,
    );
    checkExactSummaryValue(summary, "cloudStep", cloudStep, violations);
    checkExactSummaryValue(summary, "noCloud", !cloudStep, violations);
    checkExactSummaryValue(summary, "requireWork", true, violations);

    const expectedByScript = canonicalCountRecord(sortedCountRecord(byScript));
    if (canonicalCountRecord(summary.byScript) !== expectedByScript) {
      violations.push(
        "plan summary contract: byScript does not exactly match task records",
      );
    }
    const expectedByPackage = canonicalCountRecord(
      sortedCountRecord(byPackage),
    );
    if (canonicalCountRecord(summary.byPackage) !== expectedByPackage) {
      violations.push(
        "plan summary contract: byPackage does not exactly match task records",
      );
    }
  }

  planReport.push({
    check: "workspace package scripts",
    observed: `${sourceBackedTasks}/${tasks.length} source-backed`,
    expected: "every task",
    status: sourceContractValid ? "OK" : "INVALID",
  });
  planReport.push({
    check: "exact plan summary",
    observed: `${tasks.length} task(s)`,
    expected: "derived task records",
    status: violations.length === summaryViolationStart ? "OK" : "INVALID",
  });
}

export function writeSummary(summaryPath, laneReport, planReport, violations) {
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
  lines.push("### Plan source contract");
  lines.push("");
  lines.push("| Check | Observed | Expected | Status |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of planReport) {
    lines.push(
      `| ${row.check} | ${row.observed} | ${row.expected} | ${row.status} |`,
    );
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
  const planReport = [];

  checkWorkflowLanes(manifest, violations, laneReport);
  checkReusableWorkflows(manifest, violations, laneReport);
  checkPostMergeSignal(manifest, violations, laneReport);
  checkPlanContract(
    plan,
    violations,
    planReport,
    options.sourceRoot ?? repoRoot,
  );

  return { manifest, plan, violations, laneReport, planReport };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // error-policy:J1 CLI boundary translates invalid arguments to usage failure.
    console.error(`[ci-full-matrix-proof] ERROR ${error.message}`);
    process.exit(2);
  }

  const { violations, laneReport, planReport } = runProof(options);

  for (const row of laneReport) {
    console.log(`[ci-full-matrix-proof] lane ${row.lane} — ${row.status}`);
  }
  for (const row of planReport) {
    console.log(
      `[ci-full-matrix-proof] plan ${row.check} — ${row.status} (${row.observed})`,
    );
  }

  writeSummary(options.summary, laneReport, planReport, violations);

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
