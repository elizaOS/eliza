// Shares script lib repo root helpers across repo automation entrypoints.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function resolveRepoRoot(importMetaUrl, depth = 1) {
  return path.resolve(
    getModuleDir(importMetaUrl),
    ...Array.from({ length: depth }, () => ".."),
  );
}

/**
 * Walk up from `startDir` and return the first directory whose package.json
 * declares a `workspaces` key (the monorepo root). Falls back to `startDir`
 * (resolved) when no such manifest is found before the filesystem root — this
 * is the runtime-invariant root finder scripts use when their cwd is arbitrary
 * (postinstall, per-package build steps).
 */
export function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(current, "package.json"), "utf8"),
      );
      if (parsed?.workspaces) return current;
    } catch {
      // error-policy:J3 no/invalid manifest here — keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}
