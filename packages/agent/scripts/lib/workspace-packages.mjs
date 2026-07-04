import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const SKIPPED_DIRS = new Set([
  ".git",
  ".turbo",
  "android",
  "build",
  "dist",
  "dist-mobile",
  "dist-mobile-ios",
  "dist-mobile-ios-jsc",
  "ios",
  "node_modules",
]);

function readPackageName(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function realpathIfPossible(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function collectWorkspacePackages(root, packagesByName) {
  if (!existsSync(root)) return;
  const entries = readdirSync(root, { withFileTypes: true });
  if (
    entries.some((entry) => entry.isFile() && entry.name === "package.json")
  ) {
    const packageJsonPath = path.join(root, "package.json");
    const packageName = readPackageName(packageJsonPath);
    if (packageName?.startsWith("@elizaos/")) {
      packagesByName.set(packageName, realpathIfPossible(root));
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
    collectWorkspacePackages(path.join(root, entry.name), packagesByName);
  }
}

export function createWorkspacePackageResolver({
  repoRoot,
  nodeModulesRoots = [path.join(repoRoot, "node_modules")],
  workspaceRoots = [
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "plugins"),
  ],
} = {}) {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }

  const nodeModuleCache = new Map();
  const workspaceCache = new Map();
  let workspacePackages = null;

  function resolveFromNodeModules(packageName) {
    if (nodeModuleCache.has(packageName))
      return nodeModuleCache.get(packageName);
    for (const root of nodeModulesRoots) {
      const candidate = path.join(root, ...packageName.split("/"));
      if (existsSync(candidate)) {
        const resolved = realpathIfPossible(candidate);
        nodeModuleCache.set(packageName, resolved);
        return resolved;
      }
    }
    nodeModuleCache.set(packageName, null);
    return null;
  }

  function resolveFromWorkspace(packageName) {
    if (workspaceCache.has(packageName)) return workspaceCache.get(packageName);
    if (!workspacePackages) {
      workspacePackages = new Map();
      for (const root of workspaceRoots) {
        collectWorkspacePackages(root, workspacePackages);
      }
    }
    const resolved = workspacePackages.get(packageName) ?? null;
    workspaceCache.set(packageName, resolved);
    return resolved;
  }

  return function resolvePackageDir(packageName) {
    return (
      resolveFromNodeModules(packageName) ?? resolveFromWorkspace(packageName)
    );
  };
}
