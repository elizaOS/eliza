#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for prune cdn local assets mjs. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { APP_DIST_BOOTSTRAP_ASSETS } from "./lib/static-asset-manifest.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appDir = resolveMainAppDir(repoRoot, "app");
const distDir = path.join(appDir, "dist");
const publicDir = path.join(appDir, "public");
const cleanupHelperScript = resolveCleanupHelperScript();
const heavyDirs = ["animations", "vrms", "worlds"];

function exists(candidate) {
  return fs.existsSync(candidate);
}

function resolveCleanupHelperScript() {
  const candidates = [
    path.join(repoRoot, "packages", "scripts", "rm-path-recursive.mjs"),
    path.join(
      repoRoot,
      "eliza",
      "packages",
      "scripts",
      "rm-path-recursive.mjs",
    ),
  ];
  return candidates.find(exists) ?? candidates[0];
}

function removePathRecursive(targetPath) {
  if (!exists(targetPath)) {
    return;
  }

  const result = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `cleanup helper failed for ${targetPath}${output ? `:\n${output}` : ""}`,
    );
  }
}

function resetHeavyDirs() {
  for (const dir of heavyDirs) {
    removePathRecursive(path.join(distDir, dir));
  }
}

function copyBootstrapAssets() {
  for (const relativePath of APP_DIST_BOOTSTRAP_ASSETS) {
    const sourcePath = path.join(publicDir, relativePath);
    const targetPath = path.join(distDir, relativePath);
    if (!exists(sourcePath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function main() {
  if (!exists(distDir) || !exists(publicDir)) {
    return;
  }
  resetHeavyDirs();
  copyBootstrapAssets();
  console.log("cdn-asset-prune: kept bootstrap renderer assets only.");
}

main();
