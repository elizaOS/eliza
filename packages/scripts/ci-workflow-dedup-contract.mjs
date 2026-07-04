#!/usr/bin/env node
/**
 * Contract check for #10096's workflow-dedup slice.
 *
 * Keep automatic branch coverage split by responsibility:
 * - ci.yaml owns the main branch gate.
 * - test.yml owns the broader develop branch test orchestrator.
 * - scenario-pr.yml keeps zero-key deterministic PR E2E on both main/develop.
 * - nightly/release publish workflows keep Turbo remote-cache env wiring.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

function read(rel) {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function parseInlineBranches(text, eventName, workflowRel) {
  const lines = text.split(/\r?\n/);
  const eventLine = `  ${eventName}:`;
  const eventIndex = lines.indexOf(eventLine);
  if (eventIndex < 0) {
    throw new Error(`${workflowRel}: missing on.${eventName}`);
  }

  for (let index = eventIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    const match = line.match(/^\s{4}branches:\s*\[([^\]]*)\]\s*$/);
    if (!match) continue;
    return match[1]
      .split(",")
      .map((branch) => branch.trim())
      .filter(Boolean);
  }

  throw new Error(
    `${workflowRel}: missing inline branches for on.${eventName}`,
  );
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertIncludes(text, fragment, message) {
  if (!text.includes(fragment)) {
    throw new Error(`${message}: missing ${fragment}`);
  }
}

const ci = read(".github/workflows/ci.yaml");
assertDeepEqual(
  parseInlineBranches(ci, "push", ".github/workflows/ci.yaml"),
  ["main"],
  "ci.yaml push branches",
);
assertDeepEqual(
  parseInlineBranches(ci, "pull_request", ".github/workflows/ci.yaml"),
  ["main"],
  "ci.yaml PR branches",
);

const tests = read(".github/workflows/test.yml");
assertDeepEqual(
  parseInlineBranches(tests, "push", ".github/workflows/test.yml"),
  ["develop"],
  "test.yml push branches",
);
assertDeepEqual(
  parseInlineBranches(tests, "pull_request", ".github/workflows/test.yml"),
  ["develop"],
  "test.yml PR branches",
);
assertDeepEqual(
  parseInlineBranches(tests, "merge_group", ".github/workflows/test.yml"),
  ["develop"],
  "test.yml merge queue branches",
);
assertIncludes(
  tests,
  "name: ci-ok",
  "test.yml required aggregate status",
);
assertIncludes(
  tests,
  'if [ "${GITHUB_EVENT_NAME}" = "merge_group" ]; then',
  "test.yml merge queue path-gate bypass",
);

const scenarioPr = read(".github/workflows/scenario-pr.yml");
assertDeepEqual(
  parseInlineBranches(
    scenarioPr,
    "pull_request",
    ".github/workflows/scenario-pr.yml",
  ),
  ["main", "develop"],
  "scenario-pr.yml PR branches",
);

for (const workflowRel of [
  ".github/workflows/nightly.yml",
  ".github/workflows/release.yaml",
]) {
  const workflow = read(workflowRel);
  assertIncludes(
    workflow,
    "TURBO_TOKEN: $" + "{{ secrets.TURBO_TOKEN }}",
    `${workflowRel} remote cache token`,
  );
  assertIncludes(
    workflow,
    "TURBO_TEAM: $" + "{{ vars.TURBO_TEAM }}",
    `${workflowRel} remote cache team`,
  );
  assertIncludes(
    workflow,
    "TURBO_CACHE: remote:rw",
    `${workflowRel} remote cache mode`,
  );
}

console.log("ci workflow dedup contract passed");
