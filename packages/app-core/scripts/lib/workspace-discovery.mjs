/**
 * Discover Bun/npm workspace package directories from root package.json "workspaces"
 * patterns (including globs). Used by fix-workspace-deps, replace-workspace-versions,
 * and restore-workspace-refs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} root - repo root (absolute)
 * @param {string[]} patterns - workspace glob patterns from package.json
 * @returns {string[]} absolute dirs containing a package.json
 */
export function expandPattern(root, pattern) {
  const dirs = [];
  const parts = pattern.split("/").filter(Boolean);

  function walk(base, partIndex) {
    if (partIndex >= parts.length) {
      if (existsSync(join(base, "package.json"))) {
        dirs.push(base);
      }
      return;
    }

    const segment = parts[partIndex];

    if (segment.includes("*") || segment.includes("?")) {
      if (!existsSync(base) || !statSync(base).isDirectory()) {
        return;
      }
      const regex = new RegExp(
        `^${segment
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      );
      for (const entry of readdirSync(base)) {
        if (
          entry === "node_modules" ||
          entry === "dist" ||
          entry.startsWith(".")
        ) {
          continue;
        }
        const full = join(base, entry);
        try {
          if (!statSync(full).isDirectory()) {
            continue;
          }
        } catch {
          continue;
        }
        if (regex.test(entry)) {
          walk(full, partIndex + 1);
        }
      }
    } else {
      if (segment === "node_modules") {
        return;
      }
      walk(join(base, segment), partIndex + 1);
    }
  }

  walk(root, 0);
  return dirs;
}

/**
 * @param {string} root
 * @param {string[]} patterns
 * @returns {{ workspaceDirs: string[], nameToDir: Map<string, string>, nameToVersion: Map<string, string> }}
 */
export function collectWorkspaceMaps(root, patterns) {
  const dirSet = new Set();
  for (const pattern of patterns) {
    for (const dir of expandPattern(root, pattern)) {
      dirSet.add(dir);
    }
  }
  dirSet.add(root);

  const workspaceDirs = [...dirSet].sort();
  const nameToDir = new Map();
  const nameToVersion = new Map();

  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name) {
        nameToDir.set(pkg.name, dir);
        if (typeof pkg.version === "string") {
          nameToVersion.set(pkg.name, pkg.version);
        }
      }
    } catch {
      // skip
    }
  }

  return { workspaceDirs, nameToDir, nameToVersion };
}
