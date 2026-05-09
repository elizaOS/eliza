#!/usr/bin/env bun
// Audits source imports for cross-package subpath imports.
//
// The target cutover contract is:
//   import { X } from "@elizaos/package";
// not:
//   import { X } from "@elizaos/package/internal/path";

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  REPO_ROOT,
  findImportSpecifiers,
  walkWorkspacePackages,
  walkSourceFiles,
} from "./lib/util.mjs";

const ALLOWED_SUFFIXES = new Set(["package.json"]);
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

const PACKAGE_SUBPATH_RE = /^(@(?:elizaos|babylon)\/[^/]+)\/(.+)$/;

function main() {
  const violations = [];
  const packageByDir = walkWorkspacePackages()
    .map((pkg) => ({
      name: pkg.name,
      dir: relative(REPO_ROOT, pkg.dir).replace(/\\/g, "/"),
    }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const files = walkSourceFiles(REPO_ROOT, (path) => {
    return !path.includes(`${REPO_ROOT}/scripts/refactor/`);
  });

  for (const file of files) {
    const relFile = relative(REPO_ROOT, file).replace(/\\/g, "/");
    const owner = packageByDir.find(
      (pkg) => relFile === `${pkg.dir}/package.json` || relFile.startsWith(`${pkg.dir}/`),
    )?.name;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const spec of findImportSpecifiers(source)) {
      const match = PACKAGE_SUBPATH_RE.exec(spec.specifier);
      if (!match) continue;
      const packageName = match[1];
      if (owner === packageName) continue;
      const subpath = match[2];
      if (ALLOWED_SUFFIXES.has(subpath)) continue;
      if (isAllowedAssetSubpath(subpath)) continue;
      violations.push({
        file: relFile,
        specifier: spec.specifier,
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} cross-package subpath import(s). Use package barrels instead.`,
    );
    for (const violation of violations.slice(0, 200)) {
      console.error(`${violation.file}: ${violation.specifier}`);
    }
    if (violations.length > 200) {
      console.error(`...and ${violations.length - 200} more`);
    }
    process.exit(1);
  }

  console.log("No cross-package subpath imports found.");
}

function isAllowedAssetSubpath(subpath) {
  for (const ext of ALLOWED_ASSET_EXTENSIONS) {
    if (subpath.endsWith(ext)) return true;
  }
  return false;
}

main();
