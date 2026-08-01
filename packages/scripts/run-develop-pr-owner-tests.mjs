#!/usr/bin/env node
/**
 * Selects canonical package tests for workspace owners changed by a develop pull
 * request. Live workspace discovery and a dry-run plan keep selection structural;
 * repository script tests remain a separate, unconditional workflow step.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";
import { listWorkspaceDirs } from "./lib/workspaces.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const TEST_RUNNER = "packages/scripts/run-all-tests.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Map repository files to their longest declared workspace-directory owner. */
export function selectOwningWorkspaceDirs(changedFiles, workspaceDirs) {
  const normalizedWorkspaces = workspaceDirs.map((workspaceDir) =>
    normalizeGitRepositoryPath(workspaceDir, "workspace directory"),
  );
  assertUniqueRepositoryIdentities(
    normalizedWorkspaces,
    "duplicate or case-colliding workspace directories",
  );
  const bySpecificity = [...normalizedWorkspaces].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  const owners = new Set();
  for (const changedFile of changedFiles) {
    const normalizedFile = normalizeGitRepositoryPath(
      changedFile,
      "changed repository file",
    );
    const owner = bySpecificity.find((workspaceDir) =>
      normalizedFile.startsWith(`${workspaceDir}/`),
    );
    if (owner !== undefined) owners.add(owner);
  }
  return [...owners].sort((left, right) => left.localeCompare(right));
}

/** Build the anchored run-all-tests label filter for exact workspace owners. */
export function buildOwnerFilter(ownerDirs) {
  invariant(
    ownerDirs.length > 0,
    "owner filter requires a workspace directory",
  );
  assertUniqueRepositoryIdentities(
    ownerDirs,
    "duplicate or case-colliding owner directories",
  );
  return `\\((?:${ownerDirs.map(escapeRegularExpression).join("|")})\\)#`;
}

/** Return the runner arguments used for planning or required execution. */
export function buildRunnerArgs(filter, execute) {
  return [
    TEST_RUNNER,
    ...(execute ? [] : ["--plan=json"]),
    "--only=test",
    "--no-cloud",
    "--concurrency=4",
    `--filter=${filter}`,
    ...(execute ? ["--require-work"] : []),
  ];
}

function validatePlan(plan, ownerDirs) {
  invariant(
    plan && typeof plan === "object" && Array.isArray(plan.tasks),
    "owning-package test plan must contain a tasks sequence",
  );
  invariant(
    plan.summary?.taskCount === plan.tasks.length,
    "owning-package test plan summary must exactly match its tasks",
  );
  const owners = new Set(ownerDirs);
  for (const task of plan.tasks) {
    invariant(
      task &&
        typeof task === "object" &&
        typeof task.relativeDir === "string" &&
        owners.has(task.relativeDir),
      "owning-package test plan contains a task outside the selected owners",
    );
    invariant(
      task.scriptName === "test",
      "owning-package test plan must select only canonical test scripts",
    );
  }
}

/** Plan and run live canonical tests for changed workspace owners, when present. */
export function runOwnerTests({
  changedFiles,
  workspaceDirs,
  planTests,
  executeTests,
}) {
  const ownerDirs = selectOwningWorkspaceDirs(changedFiles, workspaceDirs);
  if (ownerDirs.length === 0) {
    return { status: "no-workspace-owner", ownerDirs, taskCount: 0 };
  }
  const filter = buildOwnerFilter(ownerDirs);
  const plan = planTests(filter);
  validatePlan(plan, ownerDirs);
  if (plan.tasks.length === 0) {
    return { status: "no-package-tests", ownerDirs, taskCount: 0 };
  }
  executeTests(filter);
  return {
    status: "executed",
    ownerDirs,
    taskCount: plan.tasks.length,
  };
}

function runChild(args, options) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, TEST_SCRIPT_FILTER: "^test$" },
    ...options,
  });
  if (result.error) {
    throw new Error(`failed to start ${args.join(" ")}`, {
      cause: result.error,
    });
  }
  invariant(
    result.status === 0,
    `${args.join(" ")} failed with ${result.signal ?? `exit ${result.status}`}${
      typeof result.stderr === "string" && result.stderr.trim().length > 0
        ? `: ${result.stderr.trim()}`
        : ""
    }`,
  );
  return result;
}

function readChangedFiles(baseSha) {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      "-z",
      `${baseSha}...HEAD`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.error) {
    throw new Error("failed to inspect develop pull-request changes", {
      cause: result.error,
    });
  }
  invariant(
    result.status === 0,
    `git diff failed with ${result.signal ?? `exit ${result.status}`}: ${result.stderr.trim()}`,
  );
  return result.stdout.split("\0").filter(Boolean);
}

function planTests(filter) {
  const result = runChild(buildRunnerArgs(filter, false), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    // error-policy:J2 identify the selected runner plan that emitted invalid JSON
    throw new Error("owning-package test plan is not valid JSON", {
      cause: error,
    });
  }
}

function executeTests(filter) {
  runChild(buildRunnerArgs(filter, true), { stdio: "inherit" });
}

function parseArgs(args) {
  invariant(
    args.length === 2 && args[0] === "--base",
    "usage: run-develop-pr-owner-tests.mjs --base <40-character SHA>",
  );
  invariant(
    /^[0-9a-f]{40}$/i.test(args[1]),
    "--base must be a 40-character Git SHA",
  );
  return { baseSha: args[1] };
}

function main() {
  const { baseSha } = parseArgs(process.argv.slice(2));
  const result = runOwnerTests({
    changedFiles: readChangedFiles(baseSha),
    workspaceDirs: listWorkspaceDirs({ repoRoot: REPO_ROOT }),
    planTests,
    executeTests,
  });
  if (result.status === "no-workspace-owner") {
    console.log(
      "No changed file belongs to a workspace package; repository script tests remain required.",
    );
  } else if (result.status === "no-package-tests") {
    console.log(
      `Changed workspace owners expose no canonical package tests: ${result.ownerDirs.join(", ")}`,
    );
  } else {
    console.log(
      `Executed ${result.taskCount} canonical test task(s) for: ${result.ownerDirs.join(", ")}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 CLI boundary translates selection/execution failure
    console.error(
      `[develop-pr-owner-tests] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
