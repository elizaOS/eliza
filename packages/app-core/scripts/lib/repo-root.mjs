import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeElizaSubrepoRoot(dir) {
  return (
    existsSync(path.join(dir, "package.json")) &&
    existsSync(path.join(dir, "apps", "app", "package.json")) &&
    existsSync(
      path.join(dir, "eliza", "packages", "app-core", "package.json"),
    )
  );
}

function looksLikeFlatMonorepoRoot(dir) {
  return (
    existsSync(path.join(dir, "package.json")) &&
    existsSync(path.join(dir, "packages", "app-core", "package.json")) &&
    existsSync(path.join(dir, "packages", "agent", "package.json"))
  );
}

function looksLikeRepoRoot(dir) {
  return looksLikeFlatMonorepoRoot(dir) || looksLikeElizaSubrepoRoot(dir);
}

export function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);

  while (true) {
    if (looksLikeRepoRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not resolve repository root starting from ${startDir}`,
      );
    }
    current = parent;
  }
}

export function resolveRepoRootFromImportMeta(importMetaUrl) {
  return resolveRepoRoot(path.dirname(fileURLToPath(importMetaUrl)));
}
