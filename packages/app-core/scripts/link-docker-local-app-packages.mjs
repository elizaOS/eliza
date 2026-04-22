#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const { workspaceDirs } = collectWorkspaceMaps(
  repoRoot,
  rootPkg.workspaces ?? [],
);
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

function resolveSourceExportPath(packageDir, exportPath) {
  if (typeof exportPath !== "string" || !exportPath.startsWith("./dist/")) {
    return exportPath;
  }

  if (pathExists(path.join(packageDir, exportPath))) {
    return exportPath;
  }

  const sourcePath = exportPath
    .replace("./dist/", "./src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  return pathExists(path.join(packageDir, sourcePath))
    ? sourcePath
    : exportPath;
}

function rewriteDistExportsToSource(packageJsonPath, pkg) {
  const packageDir = path.dirname(packageJsonPath);
  let changed = false;

  function rewrite(value) {
    if (typeof value === "string") {
      const next = resolveSourceExportPath(packageDir, value);
      changed ||= next !== value;
      return next;
    }
    if (Array.isArray(value)) {
      return value.map((item) => rewrite(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]),
      );
    }
    return value;
  }

  const nextPkg = { ...pkg };
  nextPkg.main = rewrite(pkg.main);
  nextPkg.module = rewrite(pkg.module);
  nextPkg.types = rewrite(pkg.types);
  nextPkg.exports = rewrite(pkg.exports);

  if (!changed) return pkg;

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`);
  return nextPkg;
}

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

  let pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@elizaos/")) {
    throw new Error(
      `Invalid local package name in ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }
  pkg = rewriteDistExportsToSource(packageJsonPath, pkg);

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
