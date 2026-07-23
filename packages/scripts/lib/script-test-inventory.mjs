/**
 * Complete executable-test inventory for the non-workspace packages/scripts tree.
 *
 * Bun receives every discovered file explicitly, so nested tests and supported
 * extension or casing variants cannot fall outside its directory heuristics.
 * The same inventory also binds that runner to root test commands and the
 * required scenario workflow; a test list without an executing lane is invalid.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const SCRIPT_TEST_RUNNER =
  "node packages/scripts/run-script-tests.mjs --report reports/script-tests/inventory.json --junit reports/script-tests/junit.xml";
export const SCRIPT_TEST_LANE_COMMANDS = {
  test: "node packages/scripts/run-all-tests.mjs --only=test --no-cloud --min-tasks=200 && bun run test:scripts",
  "test:all":
    "node packages/scripts/run-all-tests.mjs --all && bun run test:scripts",
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

const SCRIPT_TEST_PATTERN = new RegExp(
  `^packages/scripts/(?:.+/)?[^/]+\\.(?:test|spec)\\.(?:${SCRIPT_TEST_EXTENSIONS.join("|")})$`,
  "i",
);

/** Exact exclusions only. Each entry must remain eligible and carry a reason. */
export const SCRIPT_TEST_EXCLUSIONS = new Map();

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeRepositoryPath(value) {
  return value.split("\\").join("/").replace(/^\.\//, "");
}

export function isScriptTestPath(value) {
  return SCRIPT_TEST_PATTERN.test(normalizeRepositoryPath(value));
}

function listRepositoryFiles(repoRoot) {
  return execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
}

function assertNoCaseCollisions(paths) {
  const seen = new Map();
  for (const file of paths) {
    const identity = file.toLocaleLowerCase("en-US");
    const previous = seen.get(identity);
    if (previous && previous !== file) {
      throw new Error(
        `[script-test-inventory] case-colliding test paths: ${previous} and ${file}`,
      );
    }
    seen.set(identity, file);
  }
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

function assertLaneContracts({ packageScripts, scenarioWorkflow }) {
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
  const stepPattern =
    /^([ \t]*)- name: Complete packages\/scripts test sweep[ \t]*$/gm;
  const matches = [...scenarioWorkflow.matchAll(stepPattern)];
  if (matches.length !== 1) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml must own exactly one Complete packages/scripts test sweep step",
    );
  }
  const match = matches[0];
  const indentation = match[1].length;
  const propertyIndentation = indentation + 2;
  const start = match.index + match[0].length;
  const following = scenarioWorkflow.slice(start).split("\n");
  const block = [];
  for (const line of following) {
    const nextStep = line.match(/^([ \t]*)-[ \t]+/);
    if (nextStep && nextStep[1].length === indentation) break;
    block.push(line);
  }
  const blockText = block.join("\n");
  const directProperty = (name) =>
    new RegExp(`^[ \\t]{${propertyIndentation}}${name}:`, "gm");
  if (directProperty("if").test(blockText)) {
    throw new Error(
      "[script-test-inventory] packages/scripts test sweep may not carry a step-level condition",
    );
  }
  if (directProperty("continue-on-error").test(blockText)) {
    throw new Error(
      "[script-test-inventory] packages/scripts test sweep may not continue on error",
    );
  }
  const runPattern = new RegExp(
    `^[ \\t]{${propertyIndentation}}run:[ \\t]+bun run test:scripts[ \\t]*$`,
    "gm",
  );
  if ([...blockText.matchAll(runPattern)].length !== 1) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml packages/scripts sweep must execute bun run test:scripts",
    );
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
  assertNoCaseCollisions(eligibleFiles);

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
      const content = readFileSync(path.join(repoRoot, file));
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
  const scenarioWorkflow =
    options.scenarioWorkflow ??
    readFileSync(
      path.join(repoRoot, ".github/workflows/scenario-pr.yml"),
      "utf8",
    );
  assertLaneContracts({ packageScripts, scenarioWorkflow });

  const lanes = [
    "package.json#test",
    "package.json#test:all",
    ".github/workflows/scenario-pr.yml#scenario-runner-e2e",
  ];
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
