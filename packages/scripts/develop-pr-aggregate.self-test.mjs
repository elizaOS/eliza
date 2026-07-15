#!/usr/bin/env node
/**
 * Deterministic contract tests for the develop PR aggregate state machine and
 * its base-trusted workflow. Synthetic check snapshots cover every terminal
 * class without calling GitHub or waiting for real runner timeouts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCanaryCheckRuns,
  CANARY_SCENARIOS,
  evaluateAggregate,
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECKS,
  renderSummary,
} from "./develop-pr-aggregate.mjs";
import {
  OBSERVED_HEAD_LINE,
  runContract,
  TRUSTED_BASE_REF_LINE,
  validateAggregateWorkflow,
} from "./develop-pr-aggregate-workflow-contract.mjs";

const NOW_MS = Date.parse("2026-07-14T01:00:00Z");
const HEAD_SHA = "a".repeat(40);
const EVENT_UPDATED_AT = new Date(NOW_MS - 90_000).toISOString();

function evaluate(checkRuns, overrides = {}) {
  return evaluateAggregate({
    checkRuns,
    headSha: HEAD_SHA,
    eventAction: "synchronize",
    eventUpdatedAt: EVENT_UPDATED_AT,
    nowMs: NOW_MS,
    terminalSettleMs: 0,
    ...overrides,
  });
}

function successRuns() {
  return buildCanaryCheckRuns("success", NOW_MS);
}

function resultFor(evaluation, context) {
  const result = evaluation.results.find((entry) => entry.context === context);
  assert(result, `missing result for ${context}`);
  return result;
}

const allGreen = evaluate(successRuns());
assert.equal(allGreen.verdict, "success");
assert.deepEqual(allGreen.counts, { passed: 9, waiting: 0, failed: 0 });

const missingBeforeDeadline = evaluate(buildCanaryCheckRuns("missing", NOW_MS));
assert.equal(missingBeforeDeadline.verdict, "waiting");
assert.equal(resultFor(missingBeforeDeadline, "gitleaks").code, "missing");
const missingAtDeadline = evaluate(buildCanaryCheckRuns("missing", NOW_MS), {
  deadlineReached: true,
});
assert.equal(missingAtDeadline.verdict, "failure");
assert.equal(resultFor(missingAtDeadline, "gitleaks").code, "missing");

const pendingBeforeDeadline = evaluate(
  buildCanaryCheckRuns("pending-timeout", NOW_MS),
);
assert.equal(pendingBeforeDeadline.verdict, "waiting");
assert.equal(resultFor(pendingBeforeDeadline, "gitleaks").code, "pending");
const pendingAtDeadline = evaluate(
  buildCanaryCheckRuns("pending-timeout", NOW_MS),
  { deadlineReached: true },
);
assert.equal(pendingAtDeadline.verdict, "failure");
assert.equal(resultFor(pendingAtDeadline, "gitleaks").code, "pending-timeout");

for (const [scenario, code] of [
  ["cancelled", "terminal-cancelled"],
  ["timed-out", "terminal-timed_out"],
  ["failed", "terminal-failure"],
  ["skipped", "skipped-forbidden"],
]) {
  const evaluation = evaluate(buildCanaryCheckRuns(scenario, NOW_MS), {
    deadlineReached: true,
  });
  assert.equal(evaluation.verdict, "failure", scenario);
  assert.equal(resultFor(evaluation, "gitleaks").code, code, scenario);
}

// Every remaining GitHub conclusion that is neither success nor skipped must
// still fail closed through the generic terminal branch, so an unexpected or
// future conclusion string can never be mistaken for a pass.
for (const conclusion of [
  "neutral",
  "action_required",
  "startup_failure",
  "stale",
]) {
  const runs = successRuns();
  runs.find(({ name }) => name === "gitleaks").conclusion = conclusion;
  const evaluation = evaluate(runs, { deadlineReached: true });
  assert.equal(evaluation.verdict, "failure", conclusion);
  assert.equal(
    resultFor(evaluation, "gitleaks").code,
    `terminal-${conclusion}`,
    conclusion,
  );
}

const settlingRuns = buildCanaryCheckRuns("cancelled", NOW_MS);
const cancelled = settlingRuns.find(({ name }) => name === "gitleaks");
cancelled.completed_at = new Date(NOW_MS - 5_000).toISOString();
const settling = evaluate(settlingRuns, { terminalSettleMs: 15_000 });
assert.equal(settling.verdict, "waiting");
assert.equal(resultFor(settling, "gitleaks").code, "terminal-settling");

const rerunRuns = buildCanaryCheckRuns("failed", NOW_MS);
const oldFailure = rerunRuns.find(({ name }) => name === "gitleaks");
rerunRuns.push({
  ...oldFailure,
  id: Number(oldFailure.id) + 10_000,
  conclusion: "success",
});
assert.equal(evaluate(rerunRuns).verdict, "success");

const wrongOwnerRuns = successRuns();
const wrongOwner = wrongOwnerRuns.find(({ name }) => name === "gitleaks");
wrongOwner.workflow_path = ".github/workflows/untrusted.yml";
const wrongOwnerEvaluation = evaluate(wrongOwnerRuns);
assert.equal(wrongOwnerEvaluation.verdict, "waiting");
assert.equal(resultFor(wrongOwnerEvaluation, "gitleaks").code, "missing");

const wrongAppRuns = successRuns();
wrongAppRuns.find(({ name }) => name === "gitleaks").app_id =
  GITHUB_ACTIONS_APP_ID + 1;
assert.equal(resultFor(evaluate(wrongAppRuns), "gitleaks").code, "missing");

const editedRuns = successRuns();
const editedStale = evaluate(editedRuns, {
  eventAction: "edited",
  eventUpdatedAt: new Date(NOW_MS - 10_000).toISOString(),
});
assert.equal(editedStale.verdict, "waiting");
assert.equal(editedStale.counts.waiting, 2);
assert.equal(resultFor(editedStale, "lint").state, "passed");
for (const context of ["check-pr-evidence", "check-pr-title"]) {
  const oldRun = editedRuns.find(({ name }) => name === context);
  editedRuns.push({
    ...oldRun,
    id: Number(oldRun.id) + 20_000,
    started_at: new Date(NOW_MS - 5_000).toISOString(),
    completed_at: new Date(NOW_MS - 1_000).toISOString(),
  });
}
assert.equal(
  evaluate(editedRuns, {
    eventAction: "edited",
    eventUpdatedAt: new Date(NOW_MS - 10_000).toISOString(),
  }).verdict,
  "success",
);

const contexts = REQUIRED_CHECKS.map(({ context }) => context);
assert.equal(new Set(contexts).size, contexts.length);
assert(!contexts.includes("Develop PR Gate"));
assert.deepEqual(CANARY_SCENARIOS, [
  "success",
  "missing",
  "cancelled",
  "timed-out",
  "failed",
  "skipped",
  "pending-timeout",
]);

const summary = renderSummary(allGreen, {
  headSha: HEAD_SHA,
  eventAction: "synchronize",
  attempt: 1,
});
assert.match(summary, /Verdict: \*\*success\*\*/);
assert.match(summary, /coverage on changed files/);

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/develop-pr-gate.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");
validateAggregateWorkflow(workflow);
assert.throws(
  () =>
    validateAggregateWorkflow(
      workflow.replace("  pull_request_target:", "  pull_request:"),
    ),
  /pull_request_target|PR-controlled/,
);
assert.throws(
  () =>
    validateAggregateWorkflow(
      workflow.replace("  checks: read", "  checks: write"),
    ),
  /checks permission|read-only/,
);
assert.throws(
  () =>
    validateAggregateWorkflow(
      workflow.replace(
        TRUSTED_BASE_REF_LINE,
        OBSERVED_HEAD_LINE.replace("HEAD_SHA: ", "ref: "),
      ),
    ),
  /trusted base checkout ref/,
);
assert.throws(
  () =>
    validateAggregateWorkflow(
      workflow.replace(
        "    types: [opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled]",
        "    types: [opened, synchronize]",
      ),
    ),
  /aggregate activity types/,
);

assert.deepEqual(runContract(), { ok: true, contexts });
console.log("develop-pr aggregate self-test passed");
