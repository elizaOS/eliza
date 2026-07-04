#!/usr/bin/env node
// Drives repo automation verify package runtime exports with explicit CLI and CI behavior.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "Usage: node packages/scripts/verify-package-runtime-exports.mjs <package-dir>",
  );
  process.exit(1);
}

const root = findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const manifestPath = path.join(packageDir, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function isRuntimeExportPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("./") &&
    !value.includes("*") &&
    !/\.(?:d\.)?[cm]?ts$/i.test(value) &&
    !/\.css$/i.test(value)
  );
}

function collectRuntimeExportPaths(value) {
  if (isRuntimeExportPath(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectRuntimeExportPaths);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const entries = Object.entries(value);
  const hasSubpathKeys = entries.some(
    ([key]) => key === "." || key.startsWith("./"),
  );
  if (hasSubpathKeys) {
    return entries.flatMap(([, entry]) => collectRuntimeExportPaths(entry));
  }

  return entries.flatMap(([condition, entry]) =>
    condition === "types" || condition === "typings"
      ? []
      : collectRuntimeExportPaths(entry),
  );
}

const required = new Set();
for (const value of [manifest.main, manifest.module]) {
  if (isRuntimeExportPath(value)) {
    required.add(value);
  }
}
for (const value of collectRuntimeExportPaths(manifest.exports)) {
  required.add(value);
}

function findMissingRuntimeExports() {
  return [...required]
    .sort()
    .filter((entry) => !fs.existsSync(path.resolve(packageDir, entry)));
}

let missing = findMissingRuntimeExports();
for (let attempt = 0; missing.length > 0 && attempt < 20; attempt += 1) {
  await delay(100 * (attempt + 1));
  missing = findMissingRuntimeExports();
}

if (missing.length > 0) {
  console.error(
    [
      `[verify-package-runtime-exports] ${manifest.name ?? packageDirArg} has ${missing.length} missing runtime export(s):`,
      ...missing.map((entry) => `  ${entry}`),
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `[verify-package-runtime-exports] verified ${required.size} runtime export(s) for ${manifest.name ?? packageDirArg}`,
);
