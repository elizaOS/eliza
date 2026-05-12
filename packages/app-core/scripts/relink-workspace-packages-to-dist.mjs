#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const root = resolveRepoRootFromImportMeta(import.meta.url);
const packageNames = process.argv.slice(2);

if (packageNames.length === 0) {
  console.error(
    "usage: node eliza/packages/app-core/scripts/relink-workspace-packages-to-dist.mjs <package-name> [package-name...]",
  );
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { workspaceDirs, nameToDir } = collectWorkspaceMaps(
  root,
  rootPkg.workspaces ?? [],
);
const candidateBases = [root, ...workspaceDirs];

function getNodeModulesEntry(baseDir, packageName) {
  const segments = packageName.split("/");
  return join(baseDir, "node_modules", ...segments);
}

function relink(entryPath, targetPath) {
  const entryParent = dirname(entryPath);
  mkdirSync(entryParent, { recursive: true });

  if (existsSync(entryPath)) {
    const currentTarget = (() => {
      try {
        return realpathSync(entryPath);
      } catch {
        return null;
      }
    })();
    const resolvedTarget = (() => {
      try {
        return realpathSync(targetPath);
      } catch {
        return null;
      }
    })();
    if (currentTarget && resolvedTarget && currentTarget === resolvedTarget) {
      return false;
    }

    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(entryPath);
    } else {
      rmSync(entryPath, {
        recursive: stat.isDirectory(),
        force: true,
      });
    }
  }

  const relativeTarget = relative(entryParent, targetPath) || ".";
  symlinkSync(relativeTarget, entryPath, "dir");
  return true;
}

let relinkedCount = 0;

for (const packageName of packageNames) {
  const workspaceDir = nameToDir.get(packageName);
  if (!workspaceDir) {
    throw new Error(`Unknown workspace package: ${packageName}`);
  }

  const distDir = join(workspaceDir, "dist");
  const distPackageJson = join(distDir, "package.json");
  if (!existsSync(distPackageJson)) {
    throw new Error(
      `Missing compiled package manifest for ${packageName}: ${relative(root, distPackageJson)}`,
    );
  }

  const entryPaths = new Set([getNodeModulesEntry(root, packageName)]);
  for (const baseDir of candidateBases) {
    const entryPath = getNodeModulesEntry(baseDir, packageName);
    if (!existsSync(entryPath)) {
      continue;
    }
    entryPaths.add(entryPath);
  }

  for (const entryPath of [...entryPaths].sort()) {
    if (relink(entryPath, distDir)) {
      relinkedCount += 1;
      console.log(
        `[workspace-dist] ${relative(root, entryPath)} -> ${relative(root, distDir)}`,
      );
    }
  }
}

console.log(
  `[workspace-dist] relinked ${relinkedCount} node_modules entr${relinkedCount === 1 ? "y" : "ies"}`,
);
