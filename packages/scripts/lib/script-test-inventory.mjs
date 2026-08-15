/**
 * Complete executable-test inventory for the manifest-less script trees:
 * packages/scripts, packages/cloud/scripts, and root-level scripts/.
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
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./repository-file-integrity.mjs";
import { execFileSync } from "./spawn-sync-captured.mjs";

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

// Cloud ops scripts live with the cloud package (packages/cloud/scripts) but
// have no workspace manifest either, so this runner owns their tests too —
// as do repository-wide helper tests under root-level scripts/, which have no
// manifest and were invisible to every required lane until #19445.
const SCRIPT_TEST_PATTERN = new RegExp(
  `^(?:packages/(?:scripts|cloud/scripts)|scripts)/(?:.+/)?[^/]*[._](?:test|spec)\\.(?:${SCRIPT_TEST_EXTENSIONS.join("|")})$`,
  "i",
);

/** Exact exclusions only. Each entry must remain eligible and carry a reason. */
export const SCRIPT_TEST_EXCLUSIONS = new Map([
  [
    "packages/scripts/__tests__/release-verdaccio.integration.test.ts",
    "the release-candidate workflow owns this slow real-registry transport test",
  ],
  [
    "scripts/federated-agent-charter-conformance.test.mjs",
    "crashes at import: validates docs/federated-agent-charter.schema.json, deleted from the tree; repair or retirement tracked in #19448",
  ],
  [
    "scripts/lifeops/connector-paths.test.mjs",
    "2/24 tests parse docs/testing/hitl-identity-slots.md, deleted from the tree; lifeops-owner repair tracked in #19448",
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
  const pathspecs = ["packages/scripts", "packages/cloud/scripts", "scripts"];
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

function parseCiWorkflow(source) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `[script-test-inventory] ci.yml is invalid YAML: ${document.errors[0].message}`,
    );
  }
  visit(document, {
    Alias(_key, node) {
      if (isAlias(node)) {
        throw new Error(
          "[script-test-inventory] ci.yml may not use YAML aliases",
        );
      }
    },
    Pair(_key, pair) {
      if (scalarKey(pair) === "<<") {
        throw new Error(
          "[script-test-inventory] ci.yml may not use YAML merge keys",
        );
      }
    },
  });
  if (!isMap(document.contents)) {
    throw new Error("[script-test-inventory] ci.yml root must be a mapping");
  }
  return document.contents;
}

function assertCiLane(ciWorkflow) {
  const root = parseCiWorkflow(ciWorkflow);
  const jobs = mappingValue(root, "jobs");
  if (!isMap(jobs)) {
    throw new Error(
      "[script-test-inventory] ci.yml must declare a jobs mapping",
    );
  }
  const job = mappingValue(jobs, "tests");
  if (!isMap(job)) {
    throw new Error("[script-test-inventory] ci.yml must declare jobs.tests");
  }
  if (mappingValue(job, "continue-on-error") !== undefined) {
    throw new Error(
      "[script-test-inventory] tests job may not continue on error",
    );
  }
  const steps = mappingValue(job, "steps");
  if (!isSeq(steps)) {
    throw new Error("[script-test-inventory] tests.steps must be a sequence");
  }
  const named = steps.items.filter(
    (step) =>
      isMap(step) &&
      mappingValue(step, "name")?.value === "Script contract tests",
  );
  if (named.length !== 1 || !isMap(named[0])) {
    throw new Error(
      "[script-test-inventory] tests job must own exactly one Script contract tests step",
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
      "[script-test-inventory] ci.yml script contract step must execute bun run test:scripts",
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

function assertLaneContracts({ packageScripts, ciWorkflow }) {
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
  assertCiLane(ciWorkflow);
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
  const ciWorkflow =
    options.ciWorkflow ??
    readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assertLaneContracts({ packageScripts, ciWorkflow });

  const lanes = [
    "package.json#test",
    "package.json#test:all",
    ".github/workflows/ci.yml#tests",
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
