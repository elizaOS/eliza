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
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./repository-file-integrity.mjs";

export const SCRIPT_TEST_RUNNER =
  "node packages/scripts/run-script-tests.mjs --report reports/script-tests/inventory.json --junit reports/script-tests/junit.xml";
export const SCRIPT_TEST_LANE_COMMANDS = {
  test: "node packages/scripts/run-all-tests.mjs --only=test --no-cloud --require-work && bun run test:scripts",
  "test:all":
    "node packages/scripts/run-all-tests.mjs --all --require-work && bun run test:scripts",
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
  `^packages/scripts/(?:.+/)?[^/]*[._](?:test|spec)\\.(?:${SCRIPT_TEST_EXTENSIONS.join("|")})$`,
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
  return normalizeGitRepositoryPath(value, "script-test inventory path");
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

function scalarKey(pair) {
  return isScalar(pair.key) && typeof pair.key.value === "string"
    ? pair.key.value
    : undefined;
}

function mappingValue(mapping, key) {
  const pair = mapping.items.find((candidate) => scalarKey(candidate) === key);
  return pair?.value;
}

function scalarString(mapping, key, label, requiredType) {
  const value = mappingValue(mapping, key);
  if (!isScalar(value) || typeof value.value !== "string") {
    throw new Error(`[script-test-inventory] ${label} must be a string scalar`);
  }
  if (requiredType !== undefined && value.type !== requiredType) {
    throw new Error(
      `[script-test-inventory] ${label} must use ${requiredType.toLocaleLowerCase("en-US")} YAML scalar syntax`,
    );
  }
  return value.value;
}

function parseScenarioWorkflow(source) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `[script-test-inventory] scenario-pr.yml is invalid YAML: ${document.errors[0].message}`,
    );
  }
  visit(document, {
    Alias(_key, node) {
      if (isAlias(node)) {
        throw new Error(
          "[script-test-inventory] scenario-pr.yml may not use YAML aliases",
        );
      }
    },
    Pair(_key, pair) {
      if (scalarKey(pair) === "<<") {
        throw new Error(
          "[script-test-inventory] scenario-pr.yml may not use YAML merge keys",
        );
      }
    },
  });
  if (!isMap(document.contents)) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml root must be a mapping",
    );
  }
  return document.contents;
}

function assertScenarioLane(scenarioWorkflow) {
  const root = parseScenarioWorkflow(scenarioWorkflow);
  const jobs = mappingValue(root, "jobs");
  if (!isMap(jobs)) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml must declare a jobs mapping",
    );
  }
  const job = mappingValue(jobs, "scenario-runner-e2e");
  if (!isMap(job)) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml must declare jobs.scenario-runner-e2e",
    );
  }
  if (
    scalarString(job, "needs", "scenario-runner-e2e.needs", "PLAIN") !==
    "changes"
  ) {
    throw new Error(
      "[script-test-inventory] scenario-runner-e2e must depend directly on changes",
    );
  }
  if (
    scalarString(job, "if", "scenario-runner-e2e.if", "PLAIN") !==
    "needs.changes.outputs.run_scenario_pr == 'true'"
  ) {
    throw new Error(
      "[script-test-inventory] scenario-runner-e2e must use the required change-gate condition",
    );
  }
  if (mappingValue(job, "continue-on-error") !== undefined) {
    throw new Error(
      "[script-test-inventory] scenario-runner-e2e may not continue on error",
    );
  }
  const steps = mappingValue(job, "steps");
  if (!isSeq(steps)) {
    throw new Error(
      "[script-test-inventory] scenario-runner-e2e.steps must be a sequence",
    );
  }
  const named = steps.items.filter(
    (step) =>
      isMap(step) &&
      mappingValue(step, "name")?.value ===
        "Complete packages/scripts test sweep",
  );
  if (named.length !== 1 || !isMap(named[0])) {
    throw new Error(
      "[script-test-inventory] scenario-runner-e2e must own exactly one Complete packages/scripts test sweep step",
    );
  }
  const step = named[0];
  for (const forbidden of [
    "continue-on-error",
    "if",
    "shell",
    "uses",
    "working-directory",
  ]) {
    if (mappingValue(step, forbidden) !== undefined) {
      throw new Error(
        `[script-test-inventory] packages/scripts test sweep may not declare ${forbidden}`,
      );
    }
  }
  if (
    scalarString(step, "run", "packages/scripts test sweep run", "PLAIN") !==
    "bun run test:scripts"
  ) {
    throw new Error(
      "[script-test-inventory] scenario-pr.yml packages/scripts sweep must execute bun run test:scripts",
    );
  }
  const env = mappingValue(step, "env");
  if (
    !isMap(env) ||
    String(mappingValue(env, "E2E_COVERAGE_GATE_ENFORCE")?.value) !== "1"
  ) {
    throw new Error(
      "[script-test-inventory] packages/scripts sweep must enforce the E2E coverage gate",
    );
  }
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
  assertScenarioLane(scenarioWorkflow);
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
