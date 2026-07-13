#!/usr/bin/env node
/**
 * Restores release workspace protocols solely from the byte-exact replacement
 * journal. Missing journals, changed manifests, invalid records, and write
 * failures abort rather than guessing which exact dependencies were temporary.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreWorkspaceReferences } from "./lib/release-manifests.mjs";

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
  const result = restoreWorkspaceReferences({ repoRoot, journalPath, dryRun });
  console.log(
    `[release-manifests] ${dryRun ? "would restore" : "restored"} ${result.changedFiles} package manifest(s)`,
  );
  return result;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) main();
