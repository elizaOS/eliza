#!/usr/bin/env node
/**
 * Ensure every workspace package under the repo workspace roots is symlinked
 * into the node_modules roots that need direct workspace package resolution.
 *
 * Why this exists: `bun install --frozen-lockfile` matches the workspace
 * globs in package.json but only creates symlinks for packages that
 * appear in some package's `dependencies`/`devDependencies` chain that
 * bun successfully traces. Empirically bun misses ~67 of the 77
 * `plugins/*` packages — including `@elizaos/plugin-pdf`, which
 * `packages/agent` depends on, but bun fails to symlink. The result is
 * `Could not resolve: "@elizaos/plugin-pdf"` at build time, breaking
 * Mobile Build Smoke (and any other build that hits the unsymlinked
 * package).
 *
 * This script reads each workspace package.json, takes its `name`
 * (typically `@elizaos/<basename>`), and ensures each configured
 * `node_modules/@elizaos/<basename>` resolves to the workspace dir via
 * a relative symlink. Idempotent — skips packages that already resolve.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Workspace globs to walk (mirrors package.json `workspaces`).
const WORKSPACE_DIRS = [
  "packages",
  "packages/app-core/platforms",
  "packages/examples",
  "cloud/packages",
  "plugins",
];

const NODE_MODULES_DIRS = ["node_modules", "packages/app/node_modules"];
const MAX_WORKSPACE_SCAN_DEPTH = 3;

function listWorkspacePackageDirs() {
  const dirs = new Set();
  for (const root of WORKSPACE_DIRS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;
    const stack = [{ dir: absolute, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = join(current.dir, entry.name);
        if (existsSync(join(pkgDir, "package.json"))) {
          dirs.add(pkgDir);
          continue;
        }
        if (current.depth < MAX_WORKSPACE_SCAN_DEPTH - 1) {
          stack.push({ dir: pkgDir, depth: current.depth + 1 });
        }
      }
    }
  }
  return [...dirs];
}

function readPackageName(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

function ensureSymlink(linkPath, targetDir) {
  // Resolve any existing entry. If it already points at the target dir we're
  // done; if it points elsewhere or is broken, replace it.
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
    try {
      const resolved = realpathSync(linkPath);
      if (resolved === realpathSync(targetDir)) return false; // already correct
    } catch {
      /* fall through and replace */
    }
    try {
      unlinkSync(linkPath);
    } catch {
      /* if it's a real directory, leave it alone — bun put it there */
      return false;
    }
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  const rel = relative(dirname(linkPath), targetDir);
  symlinkSync(rel, linkPath, "dir");
  return true;
}

function main() {
  const created = [];
  const skipped = [];
  const missingRoots = [];

  for (const pkgDir of listWorkspacePackageDirs()) {
    const name = readPackageName(pkgDir);
    if (!name || !name.startsWith("@elizaos/")) continue;

    for (const root of NODE_MODULES_DIRS) {
      const nodeModulesRoot = join(REPO_ROOT, root);
      if (!existsSync(nodeModulesRoot)) {
        missingRoots.push(root);
        continue;
      }
      const linkPath = join(nodeModulesRoot, name);
      try {
        const made = ensureSymlink(linkPath, pkgDir);
        if (made) created.push(`${root}/${name}`);
        else skipped.push(`${root}/${name}`);
      } catch (err) {
        console.warn(
          `[ensure-workspace-symlinks] failed for ${root}/${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  const missingUnique = new Set(missingRoots);
  console.log(
    `[ensure-workspace-symlinks] created=${created.length} skipped=${skipped.length} missing-roots=${missingUnique.size}`,
  );
}

main();
