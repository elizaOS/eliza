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

  // Hoist a known set of transitive deps that workspace packages re-export
  // but bun's isolated install left only at `node_modules/.bun/<name>@.../node_modules/<name>`.
  // Vite + vitest cannot follow the realpath chain on Windows when a test
  // file in `plugins/foo` imports `@elizaos/logger`, which in turn imports
  // `adze` — the resolver walks up from the importer (the plugin), not from
  // `@elizaos/logger`'s realpath. Adding a top-level `node_modules/<name>`
  // symlink unblocks the resolution everywhere.
  //
  // Add an entry whenever a workspace package depends on a package that
  // (a) appears in NO root manifest (and so isn't auto-hoisted) and
  // (b) is imported across workspace boundaries.
  const HOIST_TRANSITIVE = [
    { name: "adze", consumer: "@elizaos/logger" },
    { name: "fast-redact", consumer: "@elizaos/logger" },
  ];
  let hoisted = 0;
  for (const root of NODE_MODULES_DIRS) {
    const nodeModulesRoot = join(REPO_ROOT, root);
    if (!existsSync(nodeModulesRoot)) continue;
    for (const { name, consumer } of HOIST_TRANSITIVE) {
      const linkPath = join(nodeModulesRoot, name);
      if (existsSync(linkPath)) continue;
      const segments = consumer.split("/");
      const consumerDir = join(REPO_ROOT, "packages", segments[1]);
      const consumerNested = join(consumerDir, "node_modules", name);
      if (!existsSync(consumerNested)) continue;
      // Vite's resolver doesn't reliably traverse double-symlinks on Windows.
      // The nested workspace `node_modules/<name>` is itself a symlink into
      // `node_modules/.bun/<name>@<ver>/node_modules/<name>`; point the
      // hoisted top-level link straight at the real target so any consumer
      // (Node ESM, Vite, vitest, bun) sees a one-hop chain.
      let targetDir = consumerNested;
      try {
        targetDir = realpathSync(consumerNested);
      } catch {
        // Fall back to the nested path if realpath can't resolve.
      }
      try {
        const made = ensureSymlink(linkPath, targetDir);
        if (made) hoisted += 1;
      } catch (err) {
        console.warn(
          `[ensure-workspace-symlinks] hoist failed for ${root}/${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  const missingUnique = new Set(missingRoots);
  console.log(
    `[ensure-workspace-symlinks] created=${created.length} skipped=${skipped.length} hoisted=${hoisted} missing-roots=${missingUnique.size}`,
  );
}

main();
