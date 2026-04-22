#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const apps = [
  "app-companion",
  "app-elizamaker",
  "app-knowledge",
  "app-lifeops",
  "app-steward",
  "app-task-coordinator",
  "app-training",
  "app-shopify",
  "app-vincent",
];

const scopeDir = path.join(repoRoot, "node_modules", "@elizaos");
fs.mkdirSync(scopeDir, { recursive: true });

let linked = 0;
for (const appDirName of apps) {
  const appDir = path.join(repoRoot, "eliza", "apps", appDirName);
  const packageJsonPath = path.join(appDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `Missing local app package manifest: ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@elizaos/")) {
    throw new Error(
      `Invalid local app package name in ${path.relative(repoRoot, packageJsonPath)}`,
    );
  }

  const target = path.join(scopeDir, pkg.name.slice("@elizaos/".length));
  fs.rmSync(target, { force: true, recursive: true });
  fs.symlinkSync(path.relative(path.dirname(target), appDir), target, "dir");
  linked += 1;
}

console.log(
  `[docker-local-apps] linked ${linked} local app package${linked === 1 ? "" : "s"}`,
);
