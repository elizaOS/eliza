#!/usr/bin/env bun
/**
 * Prune the elizaOS workspace for a Feed-only Docker build.
 *
 * The Feed web app is built from the repo root because it depends on the
 * workspace (`@elizaos/shared` via file:, the `@feed/*` packages). To keep the
 * build context small, the Dockerfile excludes most non-Feed packages — but the
 * remaining package.json manifests still declare `workspace:*` dependencies on
 * the excluded packages, which makes `bun install` fail with "Workspace
 * dependency not found".
 *
 * This script scans the (pruned) tree for the package names that are actually
 * present, then removes every `workspace:*` dependency that points to an absent
 * package, from the root and from every present manifest. The Feed build only
 * needs `apps/web` + `@feed/*` + `@elizaos/shared` (and its present transitive
 * workspace deps) resolvable; the other kept packages are present for
 * resolution only and are never built, so dropping their dangling workspace
 * deps is safe.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  ".cache",
]);

function findManifests(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const fp = join(dir, e.name);
    if (e.isDirectory()) {
      findManifests(fp, acc);
    } else if (e.name === "package.json") {
      acc.push(fp);
    }
  }
}

const manifests = [];
findManifests(".", manifests);

// 1. Collect the package names actually present in the build context.
const present = new Set();
for (const fp of manifests) {
  try {
    const name = JSON.parse(readFileSync(fp, "utf8")).name;
    if (name) present.add(name);
  } catch {
    /* ignore unparseable manifests */
  }
}

// 2. Strip workspace:* deps that point to absent packages, prune root workspaces.
const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
let stripped = 0;
for (const fp of manifests) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(fp, "utf8"));
  } catch {
    continue;
  }
  let changed = false;
  for (const key of DEP_KEYS) {
    const deps = pkg[key];
    if (!deps) continue;
    for (const [dep, version] of Object.entries(deps)) {
      if (String(version).startsWith("workspace:") && !present.has(dep)) {
        delete deps[dep];
        changed = true;
        stripped++;
      }
    }
  }
  if (Array.isArray(pkg.workspaces)) {
    const next = pkg.workspaces.filter(
      (w) => w.includes("*") || w.startsWith("!") || existsSync(w),
    );
    if (next.length !== pkg.workspaces.length) {
      pkg.workspaces = next;
      changed = true;
    }
  }
  if (changed) writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(
  `[prune-workspace] manifests=${manifests.length} present=${present.size} stripped-deps=${stripped}`,
);
