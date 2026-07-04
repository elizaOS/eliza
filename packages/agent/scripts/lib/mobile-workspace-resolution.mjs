/**
 * Workspace package resolution helpers for the mobile agent bundle.
 *
 * Bun.build may run in a fresh or sparse install where a workspace package is
 * present in the checkout but not linked under node_modules. The mobile bundle
 * still needs to resolve those package sources without requiring every
 * workspace package to be built first.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function packageMatches(dir, packageName) {
  const packageJson = readJson(path.join(dir, "package.json"));
  return packageJson?.name === packageName;
}

function childDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

export function resolveWorkspacePackageRoot(repoRoot, packageName) {
  const candidates = [
    ...childDirs(path.join(repoRoot, "packages")),
    ...childDirs(path.join(repoRoot, "packages", "cloud")),
    ...childDirs(path.join(repoRoot, "packages", "native")),
    ...childDirs(path.join(repoRoot, "plugins")),
  ];

  const found = candidates.find((candidate) =>
    packageMatches(candidate, packageName),
  );
  return found ? realpathSync(found) : null;
}
