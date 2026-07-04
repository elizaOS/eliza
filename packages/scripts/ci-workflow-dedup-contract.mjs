#!/usr/bin/env node
/**
 * Contract for #10096's workflow-dedup split and the #12341 GitHub-native cache
 * migration — the two invariants that keep CI de-duplicated and on one cache
 * regime. Run in test.yml's `changes` job; a violation fails the branch's CI.
 *
 * Branch coverage stays split by responsibility, so a check never runs twice
 * across the split:
 *   - ci.yaml owns the main-branch gate (main only).
 *   - test.yml owns the develop test orchestrator and the merge-queue `ci-ok`
 *     aggregate (develop push/PR/merge_group).
 *   - scenario-pr.yml keeps zero-key deterministic PR E2E on both main+develop.
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
  assertIncludes(tests, "name: ci-ok", "test.yml required aggregate status");
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
