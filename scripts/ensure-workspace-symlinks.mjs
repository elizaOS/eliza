#!/usr/bin/env node
/**
 * Ensure every workspace package under the repo workspace roots is symlinked
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
 *
 * Second job — repair *nested* `@elizaos/*` symlinks that escape the repo.
 * When this checkout is cloned inside another workspace (the `milady`
 * wrapper has `eliza/` as a gitignored sibling), `bun install` sometimes
 * writes `plugins/<pkg>/node_modules/@elizaos/shared` (and friends) as a
 * symlink that climbs *out* of the eliza repo into the wrapper's hoisted
 * `node_modules` — pinning a published `@elizaos/shared` that lags the
 * workspace source. The result is `Export named '...' not found in
 * @elizaos/shared/index.js` at runtime boot. We re-point any nested
 * `node_modules/@elizaos/<name>` symlink at the in-repo workspace package
 * whenever one exists.
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Workspace globs to walk (mirrors package.json `workspaces`).
const WORKSPACE_DIRS = [
  "packages",
  "packages/app-core/platforms",
  "packages/native-plugins",
  "packages/examples",
  "cloud/packages",
  "plugins",
];

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

function isInsideRepo(absPath) {
  const rel = relative(REPO_ROOT, absPath);
  return (
    rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
  );
}

/**
 * Re-point any nested `node_modules/@elizaos/<name>` symlink under a
 * workspace package at the in-repo workspace package when one exists and
 * the current target escapes the repo (a stale hoisted-dep symlink).
 */
function repairNestedElizaSymlinks(pkgDir, workspaceByName, repaired) {
  const scopeDir = join(pkgDir, "node_modules", "@elizaos");
  if (!existsSync(scopeDir)) return;
  let entries;
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = `@elizaos/${entry.name}`;
    const targetDir = workspaceByName.get(name);
    if (!targetDir) continue; // not a workspace package — leave it alone
    const linkPath = join(scopeDir, entry.name);
    const stat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) continue; // real dir written by bun — don't touch
    let resolved = null;
    try {
      resolved = realpathSync(linkPath);
    } catch {
      /* broken link — fall through and repair */
    }
    if (resolved && resolved === realpathSync(targetDir)) continue; // already correct
    if (resolved && isInsideRepo(resolved)) continue; // points elsewhere in-repo — not our problem
    try {
      unlinkSync(linkPath);
      const rel = relative(dirname(linkPath), targetDir);
      symlinkSync(rel, linkPath, "dir");
      repaired.push(`${relative(REPO_ROOT, linkPath)} -> ${rel}`);
    } catch (err) {
      console.warn(
        `[ensure-workspace-symlinks] failed to repair nested ${linkPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function main() {
  const created = [];
  const skipped = [];
  const repaired = [];

  const workspaceDirs = listWorkspacePackageDirs();
  const workspaceByName = new Map();
  for (const pkgDir of workspaceDirs) {
    const name = readPackageName(pkgDir);
    if (name?.startsWith("@elizaos/")) workspaceByName.set(name, pkgDir);
  }

  for (const [name, pkgDir] of workspaceByName) {
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

  for (const pkgDir of workspaceDirs) {
    repairNestedElizaSymlinks(pkgDir, workspaceByName, repaired);
  }

  console.log(
    `[ensure-workspace-symlinks] created=${created.length} skipped=${skipped.length} repaired-nested=${repaired.length}`,
  );
  for (const line of repaired) {
    console.log(`[ensure-workspace-symlinks]   repaired ${line}`);
  }
}

main();
