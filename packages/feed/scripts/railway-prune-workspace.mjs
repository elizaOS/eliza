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
 * This script scans the pruned tree for present package names, requires every
 * workspace loaded by the production runtime, then removes dangling development
 * workspace references. The required-set check prevents a Docker ignore rule
 * from turning a missing inference or storage plugin into a healthy-looking
 * image.
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
  const entries = readdirSync(dir, { withFileTypes: true });
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
  const name = JSON.parse(readFileSync(fp, "utf8")).name;
  if (name) present.add(name);
}

const REQUIRED_PRODUCTION_WORKSPACES = [
  "@elizaos/core",
  "@elizaos/shared",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-sql",
];
const missingRequired = REQUIRED_PRODUCTION_WORKSPACES.filter(
  (packageName) => !present.has(packageName),
);
if (missingRequired.length > 0) {
  throw new Error(
    `[prune-workspace] production workspace(s) missing from Docker context: ${missingRequired.join(", ")}`,
  );
}
const REQUIRED_BUILD_FILES = [
  "plugins/plugin-build.ts",
  "plugins/plugin-build-externals.ts",
];
const missingBuildFiles = REQUIRED_BUILD_FILES.filter(
  (filePath) => !existsSync(filePath),
);
if (missingBuildFiles.length > 0) {
  throw new Error(
    `[prune-workspace] plugin build file(s) missing from Docker context: ${missingBuildFiles.join(", ")}`,
  );
}

// 2. Strip workspace:* deps that point to absent packages, prune root workspaces.
const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const ROOT_BUILD_TOOLS = new Set([
  "@elizaos/vitest-vite",
  "@typescript/typescript6",
  "bun-types",
  "turbo",
]);
let stripped = 0;
for (const fp of manifests) {
  const pkg = JSON.parse(readFileSync(fp, "utf8"));
  let changed = false;
  if (fp === "package.json") {
    // Turbo and tsc6 coordinate retained workspace builds from the root. The
    // Vitest/Vite alias and Bun types satisfy repository-wide resolution pins
    // used while bundling core and plugin declarations. Product dependencies
    // belong to their consuming workspaces; retaining the root product matrix
    // would install thousands of unrelated packages.
    for (const key of DEP_KEYS) {
      const deps = pkg[key];
      if (!deps) continue;
      for (const dependency of Object.keys(deps)) {
        if (!ROOT_BUILD_TOOLS.has(dependency)) {
          delete deps[dependency];
          changed = true;
        }
      }
      if (Object.keys(deps).length === 0) {
        delete pkg[key];
      }
    }
  }
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
