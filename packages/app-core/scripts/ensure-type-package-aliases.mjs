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

function ensureRealDirectory(dir) {
  let shouldRecreate = false;

  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      shouldRecreate = true;
    } else {
      try {
        readlinkSync(dir);
        shouldRecreate = true;
      } catch {
        // A normal directory is already usable.
      }
    }
  } catch {
    // Missing or broken paths are recreated below.
  }

  if (shouldRecreate) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function materializeTypePackage(targetTypesDir, packageName) {
  const sourceDir = findCachedTypePackageDir(packageName);
  if (!sourceDir) {
    return false;
  }

  ensureRealDirectory(targetTypesDir);
  const targetDir = path.join(targetTypesDir, packageName);
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
  });
  ensureTypeEntryPoint(targetDir, packageName);
  return true;
}

function ensureChildDirectory(parentDir, childName) {
  ensureRealDirectory(parentDir);
  const childDir = path.join(parentDir, childName);

  try {
    mkdirSync(childDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });
    mkdirSync(childDir, { recursive: true });
  }

  return childDir;
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

function ensureBunTypesAlias(targetTypesDir) {
  const bunTypesDir = ensureChildDirectory(targetTypesDir, "bun");
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
    ensureBunTypesAlias(targetTypesDir);
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
