#!/usr/bin/env node
/**
 * Ensure every workspace package under `plugins/*`, `packages/*`,
 * `packages/native-plugins/*`, and `packages/examples/*` is symlinked
 * into `node_modules/@elizaos/<basename>`.
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
 * (typically `@elizaos/<basename>`), and ensures
 * `node_modules/@elizaos/<basename>` resolves to the workspace dir via
 * a relative symlink. Idempotent — skips packages that already resolve.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Workspace globs to walk (mirrors package.json `workspaces`).
const WORKSPACE_DIRS = [
  "packages",
  "packages/native-plugins",
  "packages/examples",
  "plugins",
];

// Subdirs of `packages/examples` that contain further nested examples.
const NESTED_EXAMPLE_GLOBS = ["packages/examples"];

function listWorkspacePackageDirs() {
  const dirs = new Set();
  for (const root of WORKSPACE_DIRS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(absolute, entry.name);
      if (existsSync(join(pkgDir, "package.json"))) dirs.add(pkgDir);
    }
  }
  // One extra level for nested examples (`packages/examples/<scope>/<pkg>`).
  for (const root of NESTED_EXAMPLE_GLOBS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;
    for (const scope of readdirSync(absolute, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      const scopeDir = join(absolute, scope.name);
      for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = join(scopeDir, entry.name);
        if (existsSync(join(pkgDir, "package.json"))) dirs.add(pkgDir);
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

  for (const pkgDir of listWorkspacePackageDirs()) {
    const name = readPackageName(pkgDir);
    if (!name || !name.startsWith("@elizaos/")) continue;

    const linkPath = join(REPO_ROOT, "node_modules", name);
    try {
      const made = ensureSymlink(linkPath, pkgDir);
      if (made) created.push(name);
      else skipped.push(name);
    } catch (err) {
      console.warn(
        `[ensure-workspace-symlinks] failed for ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `[ensure-workspace-symlinks] created=${created.length} skipped=${skipped.length}`,
  );
}

main();
