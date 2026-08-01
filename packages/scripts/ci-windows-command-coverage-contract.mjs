#!/usr/bin/env node
/**
 * Validates that every Windows CI matrix command resolves to executable repository
 * source. The workflow remains the coverage authority while parsed YAML, live
 * workspace manifests, and regular-file checks reject vacuous or stale wiring.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";
import { listPackages } from "./lib/workspaces.mjs";

const require = createRequire(import.meta.url);
const { isAlias, parseDocument, visit } = require("yaml");

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKFLOW_FILE = ".github/workflows/windows-ci.yml";
const JOB_KEY = "windows";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseWorkflow(source) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${WORKFLOW_FILE}: invalid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  visit(document, {
    Alias(_key, node) {
      if (isAlias(node)) {
        throw new Error(`${WORKFLOW_FILE}: YAML aliases are not allowed`);
      }
    },
    Pair(_key, pair) {
      if (pair.key?.value === "<<") {
        throw new Error(`${WORKFLOW_FILE}: YAML merge keys are not allowed`);
      }
    },
  });
  return document.toJS({ maxAliasCount: 0 });
}

function assertUniqueTextIdentities(values, label) {
  assertUniqueRepositoryIdentities(values, label);
}

function resolveSourceFile(repoRoot, relativePath, label) {
  try {
    return assertContainedRegularFile(repoRoot, relativePath, label).relative;
  } catch (error) {
    // error-policy:J2 preserve the repository identity that failed resolution
    throw new Error(`${label} does not resolve to a regular repository file`, {
      cause: error,
    });
  }
}

/** Read the lane names and command lists from the parsed Windows job matrix. */
export function parseWindowsMatrix(repoRoot = DEFAULT_REPO_ROOT) {
  const workflowPath = assertContainedRegularFile(
    repoRoot,
    WORKFLOW_FILE,
    "Windows CI workflow",
  ).absolute;
  const workflow = parseWorkflow(readFileSync(workflowPath, "utf8"));
  invariant(
    workflow && typeof workflow === "object" && !Array.isArray(workflow),
    `${WORKFLOW_FILE}: workflow root must be a mapping`,
  );
  const include = workflow.jobs?.[JOB_KEY]?.strategy?.matrix?.include;
  invariant(
    Array.isArray(include),
    `${WORKFLOW_FILE}: jobs.${JOB_KEY}.strategy.matrix.include must be a sequence`,
  );

  return include.map((entry, index) => {
    invariant(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `${WORKFLOW_FILE}: Windows matrix entry ${index} must be a mapping`,
    );
    invariant(
      typeof entry.lane === "string" && entry.lane.trim().length > 0,
      `${WORKFLOW_FILE}: Windows matrix entry ${index} must name a lane`,
    );
    invariant(
      Array.isArray(entry.commands),
      `${WORKFLOW_FILE}: lane "${entry.lane}" commands must be a sequence`,
    );
    invariant(
      entry.commands.every(
        (command) => typeof command === "string" && command.trim().length > 0,
      ),
      `${WORKFLOW_FILE}: lane "${entry.lane}" commands must be non-empty strings`,
    );
    return {
      lane: entry.lane,
      commands: [...entry.commands],
    };
  });
}

function validateMatrix(lanes) {
  invariant(
    lanes.length > 0,
    `${WORKFLOW_FILE}: Windows matrix must declare at least one lane`,
  );
  assertUniqueTextIdentities(
    lanes.map(({ lane }) => lane),
    `${WORKFLOW_FILE}: duplicate or case-colliding lane identities`,
  );

  const commandOwners = new Map();
  for (const { lane, commands } of lanes) {
    invariant(
      commands.length > 0,
      `${WORKFLOW_FILE}: lane "${lane}" must execute at least one command`,
    );
    for (const command of commands) {
      const identity = command.normalize("NFC").toLocaleLowerCase("en-US");
      const previous = commandOwners.get(identity);
      invariant(
        previous === undefined,
        `${WORKFLOW_FILE}: command is duplicated in lanes "${previous}" and "${lane}": ${command}`,
      );
      commandOwners.set(identity, lane);
    }
  }
}

function packageIndex(repoRoot) {
  const workspacePackages = listPackages({ repoRoot });
  const byDir = new Map();
  const byName = new Map();
  for (const workspacePackage of workspacePackages) {
    byDir.set(workspacePackage.dir, workspacePackage);
    if (
      typeof workspacePackage.name === "string" &&
      workspacePackage.name.length > 0
    ) {
      byName.set(workspacePackage.name, workspacePackage);
    }
  }
  return { byDir, byName };
}

function tokenize(command) {
  invariant(
    !/[\r\n;&|<>`]/.test(command) && !command.includes("$("),
    `compound shell syntax is unsupported in Windows matrix command: ${command}`,
  );
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  invariant(
    quote === null,
    `unterminated quote in Windows matrix command: ${command}`,
  );
  if (started) tokens.push(current);
  return tokens;
}

function resolvePackageScript(repoRoot, index, directory, scriptName, command) {
  const normalizedDirectory = normalizeGitRepositoryPath(
    directory,
    `${command}: package directory`,
  );
  const workspacePackage = index.byDir.get(normalizedDirectory);
  invariant(
    workspacePackage !== undefined,
    `${command}: ${normalizedDirectory} does not resolve to a workspace package`,
  );
  invariant(
    typeof workspacePackage.packageJson.scripts?.[scriptName] === "string" &&
      workspacePackage.packageJson.scripts[scriptName].trim().length > 0,
    `${command}: ${normalizedDirectory}/package.json has no executable "${scriptName}" script`,
  );
  return `${normalizedDirectory}/package.json`;
}

function turboFilters(tokens, command) {
  const filters = [];
  for (let index = 4; index < tokens.length; index += 1) {
    if (tokens[index] === "--filter") {
      invariant(
        typeof tokens[index + 1] === "string",
        `${command}: --filter requires a workspace package name`,
      );
      filters.push(tokens[index + 1]);
      index += 1;
    } else if (tokens[index].startsWith("--filter=")) {
      const filter = tokens[index].slice("--filter=".length);
      invariant(
        filter.length > 0,
        `${command}: --filter requires a workspace package name`,
      );
      filters.push(filter);
    }
  }
  assertUniqueTextIdentities(filters, `${command}: duplicate package filters`);
  return filters;
}

function resolveNodeCommand(repoRoot, index, tokens, command) {
  invariant(
    typeof tokens[1] === "string",
    `${command}: node command must name a repository entrypoint`,
  );
  const entrypoint = resolveSourceFile(
    repoRoot,
    tokens[1],
    `${command}: Node entrypoint`,
  );
  const sources = [entrypoint];

  if (entrypoint === "packages/scripts/run-turbo.mjs") {
    invariant(
      tokens[2] === "run" &&
        typeof tokens[3] === "string" &&
        !tokens[3].startsWith("-"),
      `${command}: run-turbo must select one task`,
    );
    const filters = turboFilters(tokens, command);
    invariant(
      filters.length > 0,
      `${command}: Windows run-turbo commands must use exact package filters`,
    );
    for (const filter of filters) {
      const workspacePackage = index.byName.get(filter);
      invariant(
        workspacePackage !== undefined,
        `${command}: package filter "${filter}" does not resolve to a workspace package`,
      );
      invariant(
        typeof workspacePackage.packageJson.scripts?.[tokens[3]] === "string" &&
          workspacePackage.packageJson.scripts[tokens[3]].trim().length > 0,
        `${command}: ${workspacePackage.dir}/package.json has no executable "${tokens[3]}" script`,
      );
      sources.push(`${workspacePackage.dir}/package.json`);
    }
  } else if (entrypoint === "packages/scripts/run-bash-linux-only.mjs") {
    invariant(
      typeof tokens[2] === "string" && !tokens[2].startsWith("-"),
      `${command}: run-bash-linux-only must name a repository script`,
    );
    sources.push(
      resolveSourceFile(repoRoot, tokens[2], `${command}: wrapped script`),
    );
  }
  return sources;
}

function resolveCommand(repoRoot, index, lane, command) {
  const tokens = tokenize(command);
  if (tokens[0] === "node") {
    return resolveNodeCommand(repoRoot, index, tokens, command);
  }
  if (
    tokens[0] === "bun" &&
    tokens[1] === "run" &&
    tokens[2] === "--cwd" &&
    typeof tokens[3] === "string" &&
    typeof tokens[4] === "string" &&
    !tokens[4].startsWith("-")
  ) {
    return [
      resolvePackageScript(repoRoot, index, tokens[3], tokens[4], command),
    ];
  }
  throw new Error(
    `${WORKFLOW_FILE}: lane "${lane}" uses unsupported command shape: ${command}`,
  );
}

/** Resolve every Windows lane command to the live files that make it executable. */
export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const lanes = parseWindowsMatrix(repoRoot);
  validateMatrix(lanes);
  const index = packageIndex(repoRoot);
  const resolved = lanes.flatMap(({ lane, commands }) =>
    commands.map((command) => ({
      lane,
      command,
      sources: resolveCommand(repoRoot, index, lane, command),
    })),
  );
  return {
    laneCount: lanes.length,
    commandCount: resolved.length,
    resolved,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { commandCount, laneCount } = runContract();
    console.log(
      `ci windows command source contract passed (${laneCount} lane(s); ${commandCount} command(s) resolved)`,
    );
  } catch (error) {
    // error-policy:J1 CLI boundary translates validation failure to a nonzero exit
    console.error(
      `[ci-windows-command-coverage-contract] FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
