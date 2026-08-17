#!/usr/bin/env node
/**
 * Synchronizes the release cohort to one canonical version so a transactional
 * release candidate can be dispatched. Updates every cohort package manifest,
 * lerna.json, and the private repository root to the exact requested version,
 * then proves the result by resolving the full release cohort contract. The
 * script never touches dependency ranges: workspace protocol ranges are
 * rewritten at pack time by the candidate builder, and any incompatible
 * literal range is surfaced by the contract check instead of silently edited.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadReleaseCohort,
  resolveReleaseCohort,
} from "./lib/release-contract.mjs";
import { applyManifestTransaction } from "./lib/release-manifests.mjs";
import { listPackages } from "./lib/workspaces.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function argumentValue(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function detectIndent(source) {
  const match = source.match(/^([ \t]+)"/m);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

function versionUpdate(filePath, version) {
  const originalSource = readFileSync(filePath, "utf8");
  const manifest = JSON.parse(originalSource);
  if (manifest.version === version) {
    return { filePath, originalSource, nextSource: originalSource };
  }
  manifest.version = version;
  const nextSource = `${JSON.stringify(manifest, null, detectIndent(originalSource))}\n`;
  return { filePath, originalSource, nextSource };
}

export function prepareReleaseVersion({ repoRoot, cohortPath, version }) {
  const root = path.resolve(repoRoot);
  const cohortFile = path.resolve(root, cohortPath);
  const packageNames = loadReleaseCohort(cohortFile);
  const workspaceByName = new Map(
    listPackages({ repoRoot: root })
      .filter(({ name }) => typeof name === "string" && name.length > 0)
      .map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const updates = [];
  for (const packageName of packageNames) {
    const workspacePackage = workspaceByName.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Cohort package ${packageName} is not a workspace`);
    }
    updates.push(
      versionUpdate(
        path.join(root, workspacePackage.dir, "package.json"),
        version,
      ),
    );
  }
  updates.push(versionUpdate(path.join(root, "package.json"), version));
  updates.push(versionUpdate(path.join(root, "lerna.json"), version));
  const changedFiles = applyManifestTransaction(updates);
  resolveReleaseCohort({ repoRoot: root, packageNames, version });
  return { changedFiles, packageCount: packageNames.length };
}

function main() {
  const args = process.argv.slice(2);
  const version = argumentValue(args, "--version", { required: true });
  const repoRoot = path.resolve(
    argumentValue(args, "--repo-root") || DEFAULT_REPO_ROOT,
  );
  const cohortPath =
    argumentValue(args, "--cohort") || "packages/scripts/release-cohort.json";
  const { changedFiles, packageCount } = prepareReleaseVersion({
    repoRoot,
    cohortPath,
    version,
  });
  process.stdout.write(
    `Prepared ${packageCount} cohort packages at ${version} (${changedFiles} files changed); cohort contract resolved.\n`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
