#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
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
];

const scopeDir = path.join(repoRoot, "node_modules", "@elizaos");
fs.mkdirSync(scopeDir, { recursive: true });

let linked = 0;
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

  const target = path.join(scopeDir, pkg.name.slice("@elizaos/".length));
  fs.rmSync(target, { force: true, recursive: true });
  fs.symlinkSync(path.relative(path.dirname(target), packageDir), target, "dir");
  linked += 1;
}

console.log(
  `[docker-local-apps] linked ${linked} local package${linked === 1 ? "" : "s"}`,
);
