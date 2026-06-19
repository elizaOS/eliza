#!/usr/bin/env node
// OS-3 gate: confidential-artifacts-check (plan §3-§4).
//
// Asserts the boot-consumable enforcement artifacts are CONSISTENT with
// confidential-policy.json — bidirectionally:
//
//   - every policy setting that maps to a cmdline token / sysctl entry /
//     masked unit is PRESENT in the corresponding artifact, and
//   - the artifact contains NO line that the policy does not call for.
//
// The mapping is the shared confidential-enforcement-map.mjs. Drift in either
// direction (a relaxed policy with a still-strict artifact, or a hand-edited
// artifact that diverges from the policy) is a hard fail-closed error: these
// files are what actually boots the guest, so they must equal the policy's
// enforcement form exactly.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-confidential-artifacts.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  expectedCmdlineTokens,
  expectedMaskedUnits,
  expectedSysctlEntries,
} from "./confidential-enforcement-map.mjs";
import { parseArgs, readJson, repoRoot } from "./os-release-lib.mjs";

const CONFIDENTIAL_DIR = path.join(repoRoot, "packages/os/linux/confidential");
const DEFAULT_POLICY = path.join(
  CONFIDENTIAL_DIR,
  "policy/confidential-policy.json",
);
const ARTIFACT_PATHS = {
  cmdline: path.join(CONFIDENTIAL_DIR, "cmdline.conf"),
  sysctl: path.join(CONFIDENTIAL_DIR, "sysctl.d/99-confidential.conf"),
  masked: path.join(CONFIDENTIAL_DIR, "masked-units.txt"),
};

// Significant lines = non-blank, non-comment, trimmed.
function significantLines(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// sysctl lines are normalized to `key = value` (collapse surrounding spaces) so
// formatting differences do not falsely pass or fail the set comparison.
function normalizeSysctl(line) {
  const match = line.match(/^([^=]+?)\s*=\s*(.+)$/);
  if (!match) return line;
  return `${match[1].trim()} = ${match[2].trim()}`;
}

// Compare an actual set of lines against the expected set, both ways.
function diffSets(label, actual, expected) {
  const errors = [];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const want of expectedSet) {
    if (!actualSet.has(want)) {
      errors.push(`${label}: missing policy-required line "${want}"`);
    }
  }
  for (const have of actualSet) {
    if (!expectedSet.has(have)) {
      errors.push(
        `${label}: line "${have}" is not derivable from confidential-policy.json`,
      );
    }
  }
  if (actual.length !== actualSet.size) {
    errors.push(`${label}: contains duplicate lines`);
  }
  return errors;
}

// Pure check usable by tests: takes the policy and the three artifact contents.
export function checkConfidentialArtifacts(policy, artifacts) {
  const errors = [];
  errors.push(
    ...diffSets(
      "cmdline.conf",
      significantLines(artifacts.cmdline),
      expectedCmdlineTokens(policy),
    ),
  );
  errors.push(
    ...diffSets(
      "sysctl.d/99-confidential.conf",
      significantLines(artifacts.sysctl).map(normalizeSysctl),
      expectedSysctlEntries(policy),
    ),
  );
  errors.push(
    ...diffSets(
      "masked-units.txt",
      significantLines(artifacts.masked),
      expectedMaskedUnits(policy),
    ),
  );
  return { ok: errors.length === 0, errors };
}

async function loadArtifacts() {
  const [cmdline, sysctl, masked] = await Promise.all([
    readFile(ARTIFACT_PATHS.cmdline, "utf8"),
    readFile(ARTIFACT_PATHS.sysctl, "utf8"),
    readFile(ARTIFACT_PATHS.masked, "utf8"),
  ]);
  return { cmdline, sysctl, masked };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath =
    typeof args.policy === "string" ? args.policy : DEFAULT_POLICY;
  const [policy, artifacts] = await Promise.all([
    readJson(policyPath),
    loadArtifacts(),
  ]);
  const result = checkConfidentialArtifacts(policy, artifacts);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error(
      "confidential-artifacts-check: FAIL-CLOSED (regenerate with generate-confidential-artifacts.mjs)",
    );
    process.exit(1);
  }
  console.log(`confidential-artifacts-check: PASS (${policyPath})`);
}

export { ARTIFACT_PATHS, loadArtifacts };

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
