#!/usr/bin/env node
/**
 * Rewrites release-managed workspace protocols to exact package versions and
 * records a byte-exact restoration journal. Discovery and mutation are
 * transactional, so malformed manifests or unresolved targets abort visibly.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceWorkspaceReferences } from "./lib/release-manifests.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
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
  const journalPath = path.resolve(
    argumentValue(args, "--journal") ||
      path.join(repoRoot, "artifacts/release-workspace-refs.json"),
  );
  const dryRun = args.includes("--dry-run");
  const result = replaceWorkspaceReferences({ repoRoot, journalPath, dryRun });
  console.log(
    `[release-manifests] ${dryRun ? "would rewrite" : "rewrote"} ${result.changedFiles} package manifest(s)`,
  );
  if (!dryRun)
    console.log(`[release-manifests] restoration journal: ${journalPath}`);
  return result;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) main();
