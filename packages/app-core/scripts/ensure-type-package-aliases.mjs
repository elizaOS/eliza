#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ROOT_NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const ELIZA_NODE_MODULES = path.join(REPO_ROOT, "eliza", "node_modules");
const GLOBAL_TYPES_CACHE_DIR = path.join(
  process.env.HOME || "",
  ".bun",
  "install",
  "cache",
  "@types",
);
const TYPE_ROOTS = [
  path.join(ROOT_NODE_MODULES, "@types"),
  path.join(ELIZA_NODE_MODULES, "@types"),
];
const BUN_TYPES_LINK_ROOTS = [
  path.join(ROOT_NODE_MODULES, ".bun", "node_modules", "@types"),
  path.join(ELIZA_NODE_MODULES, ".bun", "node_modules", "@types"),
];
const MATERIALIZED_TYPE_PACKAGES = [
  "chai",
  "cross-spawn",
  "fs-extra",
  "mdx",
  "node",
  "pg",
  "qrcode",
  "react",
  "react-dom",
  "react-test-renderer",
  "three",
  "ws",
];

function collectBrokenBundledTypePackages() {
  const packageNames = new Set();

  for (const linkRoot of BUN_TYPES_LINK_ROOTS) {
    if (!existsSync(linkRoot)) {
      continue;
    }

    for (const entry of readdirSync(linkRoot)) {
      const entryPath = path.join(linkRoot, entry);
      try {
        const stat = lstatSync(entryPath);
        if (!stat.isSymbolicLink()) {
          continue;
        }

        const resolvedPath = path.resolve(linkRoot, readlinkSync(entryPath));
        if (!existsSync(resolvedPath)) {
          packageNames.add(entry);
        }
      } catch {
        packageNames.add(entry);
      }
    }
  }

  return [...packageNames].sort();
}

function findCachedTypePackageDir(packageName) {
  if (!existsSync(GLOBAL_TYPES_CACHE_DIR)) {
    return null;
  }

  const prefix = `${packageName}@`;
  const matches = readdirSync(GLOBAL_TYPES_CACHE_DIR)
    .filter((entry) => entry.startsWith(prefix))
    .sort((a, b) =>
      b.localeCompare(a, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

  if (matches.length === 0) {
    return null;
  }

  return path.join(GLOBAL_TYPES_CACHE_DIR, matches[0]);
}

function repairBrokenDirectoryLink(dir) {
  try {
    const stat = lstatSync(dir);
    if (!stat.isSymbolicLink()) {
      return;
    }

    const resolvedPath = path.resolve(path.dirname(dir), readlinkSync(dir));
    if (!existsSync(resolvedPath)) {
      unlinkSync(dir);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function ensureTypeRoot(targetTypesDir) {
  repairBrokenDirectoryLink(targetTypesDir);
  mkdirSync(targetTypesDir, { recursive: true });
}

function materializeTypePackage(targetTypesDir, packageName) {
  const sourceDir = findCachedTypePackageDir(packageName);
  if (!sourceDir) {
    return false;
  }

  const targetDir = path.join(targetTypesDir, packageName);
  rmSync(targetDir, { recursive: true, force: true });
  ensureTypeRoot(targetTypesDir);
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
  });
  ensureTypeEntryPoint(targetDir, packageName);
  return true;
}

function ensureTypeEntryPoint(targetDir, packageName) {
  const entryPoint = path.join(targetDir, "index.d.ts");
  if (existsSync(entryPoint)) {
    return;
  }

  const packageJsonPath = path.join(targetDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const dependencyNames = Object.keys(packageJson.dependencies ?? {});
    if (dependencyNames.length === 1 && dependencyNames[0] === packageName) {
      writeFileSync(entryPoint, `export * from "${packageName}";\n`, "utf8");
    }
  } catch {
    // Leave stub packages untouched if their metadata cannot be parsed.
  }
}

export function ensureBunTypesAlias(targetTypesDir) {
  ensureTypeRoot(targetTypesDir);
  const bunTypesDir = path.join(targetTypesDir, "bun");
  mkdirSync(bunTypesDir, { recursive: true });
  writeFileSync(
    path.join(bunTypesDir, "index.d.ts"),
    '/// <reference types="bun-types" />\n',
    "utf8",
  );
  writeFileSync(
    path.join(bunTypesDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@types/bun",
        private: true,
        types: "index.d.ts",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function main() {
  let materializedCount = 0;
  const packageNames = [
    ...new Set([
      ...MATERIALIZED_TYPE_PACKAGES,
      ...collectBrokenBundledTypePackages(),
    ]),
  ].sort();

  for (const targetTypesDir of TYPE_ROOTS) {
    for (const packageName of packageNames) {
      if (materializeTypePackage(targetTypesDir, packageName)) {
        materializedCount++;
      }
    }
    ensureBunTypesAlias(targetTypesDir);
  }

  console.log(
    `[ensure-type-package-aliases] materialized ${materializedCount} @types package copies and refreshed Bun shims`,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  main();
}
