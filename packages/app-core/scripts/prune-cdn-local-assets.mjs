#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIST_BOOTSTRAP_ASSETS } from "./lib/static-asset-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appDir = path.join(repoRoot, "apps", "app");
const distDir = path.join(appDir, "dist");
const publicDir = path.join(appDir, "public");
const heavyDirs = ["animations", "vrms", "worlds"];

function exists(candidate) {
  return fs.existsSync(candidate);
}

function resetHeavyDirs() {
  for (const dir of heavyDirs) {
    fs.rmSync(path.join(distDir, dir), { recursive: true, force: true });
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
