#!/usr/bin/env node
/**
 * Sets public access on selected publishable @elizaos workspace manifests.
 * It uses the shared fail-closed resolver and stages every rewrite before any
 * file changes, preventing malformed manifests from yielding a partial result.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseCohort } from "../packages/scripts/lib/release-contract.mjs";
import { setPublicAccess } from "../packages/scripts/lib/release-manifests.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    cohort: null,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg.startsWith("--repo-root=")) {
      const val = arg.slice("--repo-root=".length).trim();
      if (!val) {
        throw new Error(
          "[release-manifests] --repo-root requires a directory path",
        );
      }
      options.repoRoot = path.resolve(val);
    } else if (arg === "--repo-root") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          "[release-manifests] --repo-root requires a directory path",
        );
      }
      options.repoRoot = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--cohort=")) {
      const val = arg.slice("--cohort=".length).trim();
      if (!val) {
        throw new Error(
          "[release-manifests] --cohort requires a file path",
        );
      }
      options.cohort = path.resolve(val);
    } else if (arg === "--cohort") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          "[release-manifests] --cohort requires a file path",
        );
      }
      options.cohort = path.resolve(next);
      index += 1;
    } else {
      throw new Error(`[release-manifests] Unknown option: ${arg}`);
    }
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: node scripts/release-set-public-access.mjs [options]

Options:
  --repo-root=<path>  Repository root directory (default: workspace root)
  --cohort=<path>     Path to release cohort file
  --dry-run           Preview changes without modifying package.json files
  --help, -h          Show this help message`);
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return { changedFiles: 0, help: true };
  }

  const repoRoot = options.repoRoot;
  const packageNames = options.cohort
    ? loadReleaseCohort(options.cohort)
    : undefined;
  const dryRun = options.dryRun;
  const result = setPublicAccess({ repoRoot, packageNames, dryRun });
  console.log(
    `[release-manifests] ${dryRun ? "would set" : "set"} publishConfig.access=public on ${result.changedFiles} package(s)`,
  );
  return result;
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const packageNames = options.cohort
    ? loadReleaseCohort(options.cohort)
    : undefined;
  const result = setPublicAccess({
    repoRoot: options.repoRoot,
    packageNames,
    dryRun: options.dryRun,
  });
  console.log(
    `[release-manifests] ${options.dryRun ? "would set" : "set"} publishConfig.access=public on ${result.changedFiles} package(s)`,
  );
  return 0;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "[release-manifests] failed",
    );
    process.exitCode = 1;
  }
}
