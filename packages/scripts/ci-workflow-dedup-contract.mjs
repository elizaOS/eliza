#!/usr/bin/env node
/**
 * Contract for #10096's workflow-dedup split and the #12341 GitHub-native cache
 * migration — the two invariants that keep CI de-duplicated and on one cache
 * regime. Run in test.yml's `changes` job; a violation fails the branch's CI.
 *
 * Branch coverage stays split by responsibility, so a check never runs twice
 * across the split (post-#14194 develop-PR-weight-reduction):
 *   - ci.yaml owns the main-branch gate (push+PR, main only).
 *   - test.yml owns the develop POST-MERGE test orchestrator and the `ci-ok`
 *     aggregate: develop `push` only (plus nightly `schedule` and
 *     `workflow_dispatch`). #14194 removed the `pull_request:[develop]` and
 *     `merge_group` triggers from test.yml. The merge queue is gone repo-wide
 *     and develop PRs run the lightweight gate instead, so the full suite
 *     never double-runs pre- and post-merge.
 *   - develop-pr.yml owns the lightweight develop-PR gate (lint/typecheck/
 *     build only, NO tests): the pre-merge half of the split.
 *   - scenario-pr.yml keeps zero-key deterministic E2E: `pull_request:[main]`
 *     pre-merge and `push:[develop]` post-merge (#14051/#14194 moved the heavy
 *     scenario family off per-PR develop runs, matching the test.yml split).
 *
 * The de-dup invariant therefore requires BOTH sides: test.yml must carry
 * develop `push` + `ci-ok` and must NOT carry a `pull_request`/`merge_group`
 * trigger (else the heavy suite would run twice), and develop-pr.yml must own
 * the `pull_request:[develop]` gate. Re-adding a PR/merge_group trigger to
 * test.yml, or dropping the develop-pr.yml gate, fails this contract.
 *
 * Cache regime (#12341): the whole repo is on the GitHub-native Turbo cache
 * (setup-bun-workspace → the pinned `turbo-cache-github` shim). NO workflow may
 * wire the Vercel SaaS remote cache (`TURBO_TOKEN`/`TURBO_TEAM`/
 * `TURBO_CACHE: remote:rw`); nightly.yml and release.yaml — the publish paths
 * that formerly pinned that env — must instead route through
 * setup-bun-workspace for the cache. Re-adding the SaaS env to any workflow, or
 * dropping the GitHub-native cache from a publish path, fails this contract.
 * This flips the pre-migration assertion, which required the SaaS wiring here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
);

const WORKFLOW_DIR = ".github/workflows";

// SaaS remote-cache wiring as actual YAML (key: value), not prose that merely
// names the env — a description mentioning TURBO_TOKEN must not trip the guard.
const SAAS_MARKERS = [
  { label: "TURBO_TOKEN", pattern: /\bTURBO_TOKEN:\s*\$\{\{/ },
  { label: "TURBO_TEAM", pattern: /\bTURBO_TEAM:\s*\$\{\{/ },
  { label: "TURBO_CACHE: remote", pattern: /\bTURBO_CACHE:\s*remote:/ },
];

function firstSaasMarker(text) {
  return SAAS_MARKERS.find(({ pattern }) => pattern.test(text))?.label ?? null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

// True iff the workflow declares a top-level `on.<eventName>:` trigger. Only
// scans the `on:` mapping block (2-space-indented keys) so an `if:` guard or a
// comment that merely names the event does not count as a trigger.
function hasInlineEvent(text, eventName) {
  const lines = text.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex < 0) return false;
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Left the `on:` mapping once we hit a non-indented (top-level) key.
    if (/^\S/.test(line)) break;
    const match = line.match(/^ {2}([a-z_]+):/);
    if (match && match[1] === eventName) return true;
  }
  return false;
}

function assertNoInlineEvent(text, eventName, workflowRel, message) {
  if (hasInlineEvent(text, eventName)) {
    throw new Error(
      `${message}: ${workflowRel} must NOT declare on.${eventName} (would double-run the heavy suite across the develop pre/post-merge split)`,
    );
  }
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

// Every workflow that wires the SaaS remote cache, as { file, label } rows.
// Exported so the test can prove the guard fires on a re-added env without
// standing up the full branch-split fixture tree.
export function findSaasRemoteCache(repoRoot = DEFAULT_REPO_ROOT) {
  const dir = resolve(repoRoot, WORKFLOW_DIR);
  const violations = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const label = firstSaasMarker(readFileSync(resolve(dir, name), "utf8"));
    if (label !== null) {
      violations.push({ file: `${WORKFLOW_DIR}/${name}`, label });
    }
  }
  return violations;
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

  // --- Branch-split invariant (#10096). ---
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
  assertIncludes(
    ci,
    "node packages/scripts/lint-lane-coverage.mjs",
    "ci.yaml enforces lane coverage",
  );
  assert(
    !ci.includes("lint-lane-coverage.mjs --dry-run"),
    "ci.yaml lane coverage must be enforced, not warn-only (#13620)",
  );

  // test.yml is the develop POST-MERGE orchestrator (#14194): develop `push`
  // only, and it must NOT carry a `pull_request` or `merge_group` trigger, or
  // the heavy suite would run both pre- and post-merge (the double-run this
  // contract exists to forbid).
  const tests = read(".github/workflows/test.yml");
  assertDeepEqual(
    parseInlineBranches(tests, "push", ".github/workflows/test.yml"),
    ["develop"],
    "test.yml push branches",
  );
  assertNoInlineEvent(
    tests,
    "pull_request",
    ".github/workflows/test.yml",
    "test.yml develop-PR gate moved to develop-pr.yml (#14194)",
  );
  assertNoInlineEvent(
    tests,
    "merge_group",
    ".github/workflows/test.yml",
    "merge queue removed repo-wide (#14194)",
  );
  assertIncludes(tests, "name: ci-ok", "test.yml required aggregate status");

  // develop-pr.yml owns the lightweight pre-merge develop-PR gate. It must
  // carry the `pull_request:[develop]` trigger that test.yml gave up, so the
  // split has an owner on the pre-merge side.
  const developPr = read(".github/workflows/develop-pr.yml");
  assertDeepEqual(
    parseInlineBranches(
      developPr,
      "pull_request",
      ".github/workflows/develop-pr.yml",
    ),
    ["develop"],
    "develop-pr.yml PR branches",
  );
  assertIncludes(
    developPr,
    "node packages/scripts/lint-lane-coverage.mjs",
    "develop-pr.yml enforces lane coverage",
  );
  assert(
    !developPr.includes("lint-lane-coverage.mjs --dry-run"),
    "develop-pr.yml lane coverage must be enforced, not warn-only (#13620)",
  );

  // scenario-pr.yml follows the same pre/post-merge split as test.yml: the
  // heavy scenario family is off per-PR develop runs (#14051/#14194), so it
  // gates PRs on `main` and runs post-merge on develop `push`.
  const scenarioPr = read(".github/workflows/scenario-pr.yml");
  assertDeepEqual(
    parseInlineBranches(
      scenarioPr,
      "pull_request",
      ".github/workflows/scenario-pr.yml",
    ),
    ["main"],
    "scenario-pr.yml PR branches",
  );
  assertDeepEqual(
    parseInlineBranches(
      scenarioPr,
      "push",
      ".github/workflows/scenario-pr.yml",
    ),
    ["develop"],
    "scenario-pr.yml develop push branches",
  );

  // --- Cache-regime invariant (#12341): one GitHub-native cache, no SaaS. ---
  const saas = findSaasRemoteCache(repoRoot);
  assert(
    saas.length === 0,
    `SaaS Turbo remote cache is banned (#12341); found ${saas
      .map(({ file, label }) => `${file} (${label})`)
      .join(", ")}. Use the GitHub-native cache via setup-bun-workspace.`,
  );

  // The publish paths must still get a Turbo cache — the GitHub-native one.
  for (const workflowRel of [
    ".github/workflows/nightly.yml",
    ".github/workflows/release.yaml",
  ]) {
    assertIncludes(
      read(workflowRel),
      "setup-bun-workspace",
      `${workflowRel} GitHub-native turbo cache (setup-bun-workspace)`,
    );
  }

  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runContract();
    console.log("ci workflow dedup contract passed");
  } catch (error) {
    console.error(`[ci-workflow-dedup-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
