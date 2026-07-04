#!/usr/bin/env node
/**
 * Contract for the protected-branch aggregate check (#13373).
 *
 * The `All Tests Passed` workflow is allowed to be the human-friendly required
 * context only if it is a real aggregate over the checks already enforced by
 * the develop ruleset. This script keeps that workflow from drifting into a
 * self-referential or vacuous green check.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const REQUIRED_CONTEXTS = [
  "Develop Gate (lint)",
  "Develop Gate (secret scan + UI determinism)",
  "Format + Type Safety Ratchet",
  "Homepage Build (PR smoke)",
  "gitleaks",
  "coverage on changed files",
  "check-pr-title",
  "stale-base guard",
];

const QUALITY_PATH_IGNORED_CONTEXTS = [
  "Develop Gate (lint)",
  "Develop Gate (secret scan + UI determinism)",
  "Format + Type Safety Ratchet",
  "Homepage Build (PR smoke)",
];

function read(rel) {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, fragment, message) {
  assert(text.includes(fragment), `${message}: missing ${fragment}`);
}

function extractLiteralBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}: |`);
  assert(start >= 0, `missing ${key} literal block`);

  const indent = lines[start].match(/^\s*/)[0].length;
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const currentIndent = line.match(/^\s*/)[0].length;
    if (currentIndent <= indent) break;
    values.push(line.trimEnd().trimStart());
  }
  return values;
}

function assertListEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${label}: expected ${expectedJson}, got ${actualJson}`,
  );
}

function assertWorkflowOwnsContext(workflowRel, fragment, context) {
  const workflow = read(workflowRel);
  assertIncludes(workflow, fragment, `${workflowRel} context ${context}`);
}

const workflow = read(".github/workflows/all-tests-passed.yml");

assertIncludes(workflow, "name: All Tests Passed", "workflow name");
assertIncludes(workflow, "  pull_request:", "pull_request trigger");
assertIncludes(workflow, "    branches: [main, develop]", "PR branches");
assertIncludes(workflow, "  workflow_dispatch:", "manual dispatch trigger");
assertIncludes(workflow, "  checks: read", "checks permission");
assertIncludes(workflow, "  statuses: read", "statuses permission");
assertIncludes(workflow, "  pull-requests: read", "pull request permission");
assertIncludes(workflow, "  all-tests-passed:", "aggregate job key");
assertIncludes(workflow, "    name: All Tests Passed", "aggregate job name");
assertIncludes(workflow, "    timeout-minutes: 90", "aggregate timeout");
assertIncludes(
  workflow,
  "node packages/scripts/all-tests-passed-workflow-contract.mjs",
  "self contract step",
);
assertIncludes(
  workflow,
  "commits/$" + "{HEAD_SHA}/check-runs?per_page=100",
  "check-run API poll",
);
assertIncludes(
  workflow,
  "commits/$" + "{HEAD_SHA}/status",
  "commit-status API poll",
);
assertIncludes(
  workflow,
  "pulls/$" + "{PR_NUMBER}/files?per_page=100",
  "PR files API for paths-ignore detection",
);
assertIncludes(
  workflow,
  'if [ "$context" = "All Tests Passed" ]; then',
  "self-dependency guard",
);
assertIncludes(
  workflow,
  "missing_or_skipped_allowed",
  "explicit missing/skipped allowlist",
);

const requiredContexts = extractLiteralBlock(workflow, "REQUIRED_CONTEXTS");
assertListEqual(requiredContexts, REQUIRED_CONTEXTS, "required contexts");
assert(
  !requiredContexts.includes("All Tests Passed"),
  "required contexts must not include the aggregate check itself",
);

const qualityIgnoredContexts = extractLiteralBlock(
  workflow,
  "QUALITY_PATH_IGNORED_CONTEXTS",
);
assertListEqual(
  qualityIgnoredContexts,
  QUALITY_PATH_IGNORED_CONTEXTS,
  "quality paths-ignore contexts",
);
for (const context of qualityIgnoredContexts) {
  assert(
    requiredContexts.includes(context),
    `paths-ignore context is not required: ${context}`,
  );
}

assertWorkflowOwnsContext(
  ".github/workflows/quality.yml",
  "name: Develop Gate (lint)",
  "Develop Gate (lint)",
);
assertWorkflowOwnsContext(
  ".github/workflows/quality.yml",
  "name: Develop Gate (secret scan + UI determinism)",
  "Develop Gate (secret scan + UI determinism)",
);
assertWorkflowOwnsContext(
  ".github/workflows/quality.yml",
  "name: Format + Type Safety Ratchet",
  "Format + Type Safety Ratchet",
);
assertWorkflowOwnsContext(
  ".github/workflows/quality.yml",
  "name: Homepage Build (PR smoke)",
  "Homepage Build (PR smoke)",
);
assertWorkflowOwnsContext(
  ".github/workflows/gitleaks.yml",
  "name: gitleaks",
  "gitleaks",
);
assertWorkflowOwnsContext(
  ".github/workflows/coverage-gate.yml",
  "name: coverage on changed files",
  "coverage on changed files",
);
assertWorkflowOwnsContext(
  ".github/workflows/pr.yaml",
  "  check-pr-title:",
  "check-pr-title",
);
assertWorkflowOwnsContext(
  ".github/workflows/stale-base-guard.yml",
  "name: stale-base guard",
  "stale-base guard",
);

console.log("all-tests-passed workflow contract passed");
