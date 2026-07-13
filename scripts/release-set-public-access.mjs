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

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

export function main(args = process.argv.slice(2)) {
  const repoRoot = path.resolve(
    argumentValue(args, "--repo-root") || DEFAULT_REPO_ROOT,
  );
  const cohortPath = argumentValue(args, "--cohort");
  const packageNames = cohortPath
    ? loadReleaseCohort(path.resolve(cohortPath))
    : undefined;
  const dryRun = args.includes("--dry-run");
  const result = setPublicAccess({ repoRoot, packageNames, dryRun });
  console.log(
    `[release-manifests] ${dryRun ? "would set" : "set"} publishConfig.access=public on ${result.changedFiles} package(s)`,
  );
  return result;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) main();
