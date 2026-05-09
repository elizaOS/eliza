#!/usr/bin/env bun
// Rewrites cross-package local subpath imports to package barrels.
//
// Examples:
//   @elizaos/agent/config/paths -> @elizaos/agent
//   @elizaos/ui/api/client      -> @elizaos/ui
//
// The script intentionally leaves self-subpath imports alone. Those are local
// package internals and do not violate the cross-package barrel contract.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  REPO_ROOT,
  makeLogger,
  parseFlags,
  rewriteImports,
  walkSourceFiles,
  walkWorkspacePackages,
  writeFileIfChanged,
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

const flags = parseFlags();
const log = makeLogger(flags);

const packageByDir = walkWorkspacePackages()
  .map((pkg) => ({
    name: pkg.name,
    dir: relative(REPO_ROOT, pkg.dir).replace(/\\/g, "/"),
  }))
  .sort((a, b) => b.dir.length - a.dir.length);
const localPackageNames = new Set(packageByDir.map((pkg) => pkg.name));

let changedFiles = 0;
let rewrittenImports = 0;
const byPackage = new Map();

log.section(
  `rewrite-subpath-imports-to-barrels${flags.apply ? " (APPLY)" : " (DRY-RUN)"}`,
);
if (!flags.apply) {
  log.note("Pass --apply to mutate files.");
}

for (const file of walkSourceFiles(REPO_ROOT, (path) => {
  return !path.includes(`${REPO_ROOT}/scripts/refactor/`);
})) {
  const relFile = relative(REPO_ROOT, file).replace(/\\/g, "/");
  const owner = packageByDir.find(
    (pkg) => relFile === `${pkg.dir}/package.json` || relFile.startsWith(`${pkg.dir}/`),
  )?.name;
  const source = readFileSync(file, "utf8");
  const result = rewriteImports(source, (specifier) => {
    const match = PACKAGE_SUBPATH_RE.exec(specifier);
    if (!match) return null;
    const [, packageName, subpath] = match;
    if (!localPackageNames.has(packageName)) return null;
    if (owner === packageName) return null;
    if (ALLOWED_SUFFIXES.has(subpath)) return null;
    if (isAllowedAssetSubpath(subpath)) return null;
    byPackage.set(packageName, (byPackage.get(packageName) ?? 0) + 1);
    return packageName;
  });
  if (result.changes === 0) continue;
  changedFiles++;
  rewrittenImports += result.changes;
  writeFileIfChanged(file, result.source, flags, log);
}

log.section("Summary");
log.summary("files changed", changedFiles);
log.summary("imports rewritten", rewrittenImports);
for (const [packageName, count] of [...byPackage.entries()].sort((a, b) => b[1] - a[1])) {
  log.info(`${packageName}: ${count}`);
}

function isAllowedAssetSubpath(subpath) {
  for (const ext of ALLOWED_ASSET_EXTENSIONS) {
    if (subpath.endsWith(ext)) return true;
  }
  return false;
}
