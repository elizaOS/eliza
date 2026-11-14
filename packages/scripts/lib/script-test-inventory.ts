/**
 * Complete executable-test inventory for the manifest-less script trees:
 * packages/scripts and packages/cloud/scripts.
 *
 * Bun receives every discovered file explicitly, so nested tests and supported
 * extension or casing variants cannot fall outside its directory heuristics.
 * The same inventory also binds that runner to root test commands and the
 * required consolidated CI workflow; a test list without an executing lane is
 * invalid. Discovery is fail-closed in both directions: a new test file under
 * any covered tree is included automatically, and the only way out is an
 * exact-path entry in SCRIPT_TEST_EXCLUSIONS with a durable reason, which the
 * validator rejects the moment it goes stale.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./repository-file-integrity.ts";
import { execFileSync } from "./spawn-sync-captured.ts";

export const SCRIPT_TEST_RUNNER =
  "node packages/scripts/run-script-tests.ts --report test-results/script-tests/inventory.json --junit test-results/script-tests/junit.xml && bun run test:scripts:node";
export const SCRIPT_TEST_LANE_COMMANDS = {
  "test:scripts:node":
    "node --conditions=eliza-source --import tsx node_modules/vitest/vitest.mjs run --config packages/scripts/vitest.node.config.ts",
};
export const SCRIPT_TEST_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
];

// One fail-closed inventory owns repository tooling and cloud operation tests.
const SCRIPT_TEST_PATTERN = new RegExp(
  `^packages/(?:scripts|cloud/scripts)/(?:.+/)?[^/]*[._](?:test|spec)\\.(?:${SCRIPT_TEST_EXTENSIONS.join("|")})$`,
  "i",
);

/** Exact exclusions only. Each entry must remain eligible and carry a reason. */
export const SCRIPT_TEST_EXCLUSIONS = new Map([
  [
    "packages/scripts/__tests__/run-content-context-soak.test.ts",
    "root test:scripts:node runs the production node:sqlite lifecycle contract under Node",
  ],
  [
    "packages/scripts/__tests__/produce-content-context-live-trajectories.test.ts",
    "root test:scripts:node runs the production node:sqlite trajectory contract under Node",
  ],
  [
    "packages/scripts/plugins/plugin-meetings/headless-capture-e2e.test.ts",
    "plugin-meetings test:e2e owns this Node browser/audio capture suite",
  ],
  [
    "packages/cloud/scripts/admin/run-integration-tests.test.ts",
    "the root test:cloud:integration command owns this Node node:sqlite lifecycle suite",
  ],
  [
    "packages/scripts/__tests__/release-verdaccio.integration.test.ts",
    "the release-candidate workflow owns this slow real-registry transport test",
  ],
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeRepositoryPath(value) {
  return normalizeGitRepositoryPath(value, "script-test inventory path");
}

export function isScriptTestPath(value) {
  return SCRIPT_TEST_PATTERN.test(normalizeRepositoryPath(value));
}

function listRepositoryFiles(repoRoot) {
  const pathspecs = ["packages/scripts", "packages/cloud/scripts"];
  const candidates = execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
  const deleted = new Set(
    execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "--deleted", "--", ...pathspecs],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split("\0")
      .filter(Boolean),
  );
  return candidates.filter((file) => !deleted.has(file));
}

function validateExclusions(eligibleFiles, exclusions) {
  const eligible = new Set(eligibleFiles);
  const records = [];
  for (const [rawPath, rawReason] of exclusions) {
    const file = normalizeRepositoryPath(rawPath);
    const reason = String(rawReason).trim();
    if (!isScriptTestPath(file)) {
      throw new Error(
        `[script-test-inventory] exclusion is not an eligible script test: ${file}`,
      );
    }
    if (!eligible.has(file)) {
      throw new Error(
        `[script-test-inventory] stale exclusion does not match a repository test: ${file}`,
      );
    }
    if (reason.length < 12) {
      throw new Error(
        `[script-test-inventory] exclusion needs a durable reason: ${file}`,
      );
    }
    records.push({ file, reason });
  }
  return records.sort((left, right) => compareText(left.file, right.file));
}

function assertLaneContracts({ packageScripts }) {
  if (packageScripts["test:scripts"] !== SCRIPT_TEST_RUNNER) {
    throw new Error(
      `[script-test-inventory] package.json test:scripts must be exactly: ${SCRIPT_TEST_RUNNER}`,
    );
  }
  for (const [rootScript, expectedCommand] of Object.entries(
    SCRIPT_TEST_LANE_COMMANDS,
  )) {
    if (packageScripts[rootScript] !== expectedCommand) {
      throw new Error(
        `[script-test-inventory] package.json ${rootScript} must be exactly: ${expectedCommand}`,
      );
    }
  }
}

/**
 * Discover all executable Bun tests under packages/scripts and bind their lanes.
 *
 * Synthetic tests may inject repository paths and lane sources. Production
 * discovery reads Git's tracked plus untracked, non-ignored file inventory.
 */
export function buildScriptTestInventory(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const candidateFiles = (
    options.candidateFiles ?? listRepositoryFiles(repoRoot)
  )
    .map(normalizeRepositoryPath)
    .sort(compareText);
  const eligibleFiles = candidateFiles.filter(isScriptTestPath);
  assertUniqueRepositoryIdentities(
    eligibleFiles,
    "[script-test-inventory] case-colliding or duplicate test paths",
  );

  const exclusionMap = options.exclusions ?? SCRIPT_TEST_EXCLUSIONS;
  const excluded = validateExclusions(eligibleFiles, exclusionMap);
  const excludedPaths = new Set(excluded.map(({ file }) => file));
  const files = eligibleFiles.filter((file) => !excludedPaths.has(file));
  if (files.length === 0) {
    throw new Error(
      "[script-test-inventory] discovered zero executable packages/scripts tests",
    );
  }

  const identities = new Map();
  if (options.verifyReadable !== false) {
    for (const file of files) {
      const { absolute } = assertContainedRegularFile(
        repoRoot,
        file,
        `[script-test-inventory] ${file}`,
      );
      const content = readFileSync(absolute);
      identities.set(file, {
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }

  const packageScripts =
    options.packageScripts ??
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
      .scripts;
  assertLaneContracts({ packageScripts });
  const lanes = ["package.json#test:scripts"];
  const inventory = {
    schemaVersion: 2,
    runner: {
      packageScript: "test:scripts",
      command: SCRIPT_TEST_RUNNER,
      sourceCondition: "eliza-source",
      lanes,
    },
    discoveredCount: files.length,
    excludedCount: excluded.length,
    files: files.map((file) => ({
      file,
      ...identities.get(file),
      lanes,
    })),
    excluded,
  };
  return {
    ...inventory,
    inventorySha256: createHash("sha256")
      .update(JSON.stringify(inventory))
      .digest("hex"),
  };
}
