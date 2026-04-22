#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const { workspaceDirs } = collectWorkspaceMaps(repoRoot, rootPkg.workspaces ?? []);
const localPackages = [
  "eliza/apps/app-companion",
  "eliza/apps/app-elizamaker",
  "eliza/apps/app-knowledge",
  "eliza/apps/app-lifeops",
  "eliza/apps/app-steward",
  "eliza/apps/app-task-coordinator",
  "eliza/apps/app-training",
  "eliza/apps/app-shopify",
  "eliza/apps/app-vincent",
  "eliza/packages/plugin-browser-bridge",
  "eliza/packages/native-plugins/activity-tracker",
  "eliza/plugins/plugin-telegram",
];

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function collectScopeDirs() {
  const scopeDirs = new Set([path.join(repoRoot, "node_modules", "@elizaos")]);
  for (const workspaceDir of workspaceDirs) {
    const scopeDir = path.join(workspaceDir, "node_modules", "@elizaos");
    if (pathExists(scopeDir)) {
      scopeDirs.add(scopeDir);
    }
  }
  return [...scopeDirs].sort();
}

let linked = 0;
const scopeDirs = collectScopeDirs();
for (const scopeDir of scopeDirs) {
  fs.mkdirSync(scopeDir, { recursive: true });
}

for (const packagePath of localPackages) {
  const packageDir = path.join(repoRoot, packagePath);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `Missing local package manifest: ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@elizaos/")) {
    throw new Error(
      `Invalid local package name in ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }

  const packageName = pkg.name.slice("@elizaos/".length);
  for (const scopeDir of scopeDirs) {
    const target = path.join(scopeDir, packageName);
    if (scopeDir !== path.join(repoRoot, "node_modules", "@elizaos")) {
      if (!pathExists(target)) {
        continue;
      }
    }
    fs.rmSync(target, { force: true, recursive: true });
    fs.symlinkSync(
      path.relative(path.dirname(target), packageDir),
      target,
      "dir",
    );
    linked += 1;
  }
}

console.log(
  `[docker-local-apps] linked ${linked} local package entr${linked === 1 ? "y" : "ies"}`,
);
