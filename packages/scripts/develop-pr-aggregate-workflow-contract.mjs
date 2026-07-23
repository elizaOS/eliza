#!/usr/bin/env node
/**
 * Static contract for the base-trusted develop pull-request aggregate.
 * It binds the stable check name to a hosted, read-only workflow and verifies
 * that every polled context still belongs to an always-emitted owner workflow
 * with the activity types modeled by the aggregate state machine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGGREGATE_TRIGGER_ACTIONS,
  CANARY_SCENARIOS,
  DEFAULT_PULL_REQUEST_ACTIONS,
  REQUIRED_CHECKS,
} from "./develop-pr-aggregate.mjs";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
);
const AGGREGATE_WORKFLOW = ".github/workflows/develop-pr-gate.yml";
export const TRUSTED_BASE_REF_LINE =
  "ref: $" + "{{ github.event.pull_request.base.sha || github.sha }}";
export const OBSERVED_HEAD_LINE =
  "HEAD_SHA: $" + "{{ github.event.pull_request.head.sha || github.sha }}";
export const DISPATCH_CANARY_LINE =
  "CANARY_SCENARIO: $" +
  "{{ github.event_name == 'workflow_dispatch' && inputs.canary || '' }}";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertIncludes(text, fragment, message) {
  assert(text.includes(fragment), `${message}: missing ${fragment}`);
}

function assertEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${message}: expected ${expectedJson}, got ${actualJson}`,
  );
}

function unquote(value) {
  return value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}

function inlineList(block, key, fallback = null) {
  const match = block.match(
    new RegExp(`^\\s{4}${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m"),
  );
  if (!match) return fallback;
  return match[1].split(",").map(unquote).filter(Boolean);
}

function eventBlock(text, eventName, workflowPath) {
  const lines = text.split(/\r?\n/);
  const onIndex = lines.indexOf("on:");
  assert(onIndex >= 0, `${workflowPath}: missing on mapping`);
  const eventIndex = lines.findIndex(
    (line, index) => index > onIndex && line === `  ${eventName}:`,
  );
  assert(eventIndex >= 0, `${workflowPath}: missing on.${eventName}`);
  const selected = [];
  for (let index = eventIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    selected.push(line);
  }
  return selected.join("\n");
}

function count(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
}

export function validateAggregateWorkflow(workflow) {
  assertIncludes(workflow, "name: Develop PR Gate", "workflow name");
  assertIncludes(
    workflow,
    "  pull_request_target:",
    "base-trusted pull-request trigger",
  );
  assert(
    !/^ {2}pull_request:/m.test(workflow),
    "aggregate must not run PR-controlled workflow code via pull_request",
  );
  const targetBlock = eventBlock(
    workflow,
    "pull_request_target",
    AGGREGATE_WORKFLOW,
  );
  assertEqual(
    inlineList(targetBlock, "branches"),
    ["develop"],
    "aggregate target branches",
  );
  assertEqual(
    inlineList(targetBlock, "types"),
    AGGREGATE_TRIGGER_ACTIONS,
    "aggregate activity types",
  );
  assert(
    !/^\s+(paths|paths-ignore):/m.test(targetBlock),
    "aggregate trigger must always emit; paths filters are forbidden",
  );
  assertIncludes(workflow, "  workflow_dispatch:", "canary dispatch trigger");
  for (const scenario of CANARY_SCENARIOS) {
    assertIncludes(workflow, `          - ${scenario}`, `canary ${scenario}`);
  }

  assertIncludes(workflow, "  contents: read", "contents permission");
  assertIncludes(workflow, "  checks: read", "checks permission");
  assertIncludes(workflow, "  actions: read", "actions permission");
  assertIncludes(workflow, "  pull-requests: read", "pull-request permission");
  assert(
    !/^\s+[a-z-]+:\s*write\s*$/m.test(workflow),
    "aggregate token permissions must remain read-only",
  );
  assert(
    !workflow.includes("${{ secrets."),
    "aggregate must not receive repository or organization secrets",
  );

  assertIncludes(workflow, "    name: Develop PR Gate", "stable job name");
  assertIncludes(workflow, "    runs-on: ubuntu-24.04", "hosted runner");
  assertIncludes(workflow, "    timeout-minutes: 45", "bounded timeout");
  assertEqual(
    count(workflow, /uses:\s*actions\/checkout@/g),
    1,
    "aggregate checkout count",
  );
  assertIncludes(workflow, TRUSTED_BASE_REF_LINE, "trusted base checkout ref");
  assertIncludes(
    workflow,
    "persist-credentials: false",
    "checkout credential isolation",
  );
  assert(
    !workflow.includes("allow-unsafe-pr-checkout"),
    "aggregate may never opt into an untrusted pull-request checkout",
  );
  assertIncludes(workflow, OBSERVED_HEAD_LINE, "PR head observation target");
  assertIncludes(
    workflow,
    "node packages/scripts/develop-pr-aggregate.self-test.mjs",
    "deterministic state-machine self-test",
  );
  assertIncludes(
    workflow,
    "node packages/scripts/develop-pr-aggregate.mjs",
    "aggregate runner",
  );
  assertIncludes(
    workflow,
    DISPATCH_CANARY_LINE,
    "dispatch-only canary boundary",
  );
}

function validateOwnerWorkflow(text, workflowPath, expectedActions) {
  const block = eventBlock(text, "pull_request", workflowPath);
  const branches = inlineList(block, "branches", []);
  assert(
    branches.length === 0 || branches.includes("develop"),
    `${workflowPath}: pull_request trigger does not cover develop`,
  );
  assert(
    !/^\s+(paths|paths-ignore):/m.test(block),
    `${workflowPath}: required owner may not disappear behind a path filter`,
  );
  assertEqual(
    inlineList(block, "types", DEFAULT_PULL_REQUEST_ACTIONS),
    expectedActions,
    `${workflowPath}: modeled pull_request activity types`,
  );
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const read = (relativePath) =>
    readFileSync(resolve(repoRoot, relativePath), "utf8");
  const aggregateWorkflow = read(AGGREGATE_WORKFLOW);
  validateAggregateWorkflow(aggregateWorkflow);

  const checksByWorkflow = Map.groupBy(
    REQUIRED_CHECKS,
    ({ workflowPath }) => workflowPath,
  );
  for (const [workflowPath, checks] of checksByWorkflow) {
    const workflow = read(workflowPath);
    const expectedActions = checks[0].triggerActions;
    for (const check of checks) {
      assertEqual(
        check.triggerActions,
        expectedActions,
        `${workflowPath}: contexts disagree about owner activity types`,
      );
      const marker =
        check.context === "lint" ||
        check.context === "typecheck" ||
        check.context === "build" ||
        check.context === "check-pr-evidence" ||
        check.context === "check-pr-title"
          ? `  ${check.context}:`
          : `name: ${check.context}`;
      assertIncludes(
        workflow,
        marker,
        `${workflowPath}: owner for ${check.context}`,
      );
    }
    validateOwnerWorkflow(workflow, workflowPath, expectedActions);
  }

  const contexts = REQUIRED_CHECKS.map(({ context }) => context);
  assertEqual(
    new Set(contexts).size,
    contexts.length,
    "required context names must be unique",
  );
  assert(
    !contexts.includes("Develop PR Gate"),
    "aggregate must not require its own check context",
  );
  return { ok: true, contexts };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = runContract();
  console.log(
    `develop-pr aggregate workflow contract passed (${result.contexts.length} contexts)`,
  );
}
