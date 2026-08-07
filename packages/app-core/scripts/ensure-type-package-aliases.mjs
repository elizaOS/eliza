#!/usr/bin/env node
/**
 * Postinstall repair step that materializes real copies of @types/* (and
 * related type shim) packages into the root and eliza/ node_modules trees,
 * replacing symlinked or missing entries the package manager left behind, so
 * typechecking resolves consistent type packages.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const CLEANUP_HELPER_SCRIPT = resolveCleanupHelperScript();
const ROOT_NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const ELIZA_NODE_MODULES = path.join(REPO_ROOT, "eliza", "node_modules");
const GLOBAL_TYPES_CACHE_DIR = path.join(
  process.env.HOME || "",
  ".bun",
  "install",
  "cache",
  "@types",
);
const GLOBAL_PACKAGE_CACHE_DIR = path.join(
  process.env.HOME || "",
  ".bun",
  "install",
  "cache",
);
const NODE_MODULE_ROOTS = [ROOT_NODE_MODULES, ELIZA_NODE_MODULES];
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
const MATERIALIZED_PACKAGES = ["bun-types", "csstype"];

function resolveCleanupHelperScript() {
  const candidates = [
    path.join(REPO_ROOT, "packages", "scripts", "rm-path-recursive.mjs"),
    path.join(
      REPO_ROOT,
      "eliza",
      "packages",
      "scripts",
      "rm-path-recursive.mjs",
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function removePathRecursive(targetPath) {
  if (!existsSync(targetPath)) {
    return;
  }

  const result = spawnSync(
    "node",
    [CLEANUP_HELPER_SCRIPT, path.relative(REPO_ROOT, targetPath)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `cleanup helper failed for ${targetPath}${output ? `:\n${output}` : ""}`,
    );
  }
}

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

const LOCKFILE_PIN_CACHE = new Map();

/**
 * Reads the resolved version each root-level package pins in a bun.lock.
 * bun.lock is JSONC (trailing commas), so scan resolution entries of the
 * form `"<name>": ["<name>@<version>", ...]` textually instead of JSON.parse.
 * Nested resolutions are keyed `"<parent>/<name>"` and fail the back-reference,
 * so only the root resolution for each package matches.
 */
export function readLockfilePinnedVersions(lockfilePath) {
  const pins = new Map();
  if (!existsSync(lockfilePath)) {
    return pins;
  }
  const lockText = readFileSync(lockfilePath, "utf8");
  const entryPattern = /"((?:@[^/"]+\/)?[^/"]+)": \["\1@([^"]+)"/g;
  for (const match of lockText.matchAll(entryPattern)) {
    if (!pins.has(match[1])) {
      pins.set(match[1], match[2]);
    }
  }
  return pins;
}

function lockfilePinsFor(nodeModulesDir) {
  const lockfilePath = path.join(path.dirname(nodeModulesDir), "bun.lock");
  if (!LOCKFILE_PIN_CACHE.has(lockfilePath)) {
    LOCKFILE_PIN_CACHE.set(
      lockfilePath,
      readLockfilePinnedVersions(lockfilePath),
    );
  }
  return LOCKFILE_PIN_CACHE.get(lockfilePath);
}

function findCachedTypePackageDir(packageName, pinnedVersion) {
  return findCachedPackageDir(
    GLOBAL_TYPES_CACHE_DIR,
    packageName,
    pinnedVersion,
  );
}

export function findCachedPackageDir(cacheDir, packageName, pinnedVersion) {
  if (!existsSync(cacheDir)) {
    return null;
  }

  const prefix = `${packageName}@`;
  const matches = readdirSync(cacheDir).filter((entry) =>
    entry.startsWith(prefix),
  );

  if (matches.length === 0) {
    return null;
  }

  // The machine-global cache accumulates every version any checkout on the
  // host ever resolved, so "newest cached" can be newer than what this
  // checkout's lockfile pins. Materializing that newer copy over the
  // installed pin is how typechecking drifts from `bun install
  // --frozen-lockfile` (a cached @types/node@26.x once broke every
  // packages/core build on runners whose lockfile pinned 25.x). Prefer the
  // pinned version; if it is not cached, keep the installed copy rather than
  // stomp it with a mismatched one.
  if (pinnedVersion) {
    const pinnedEntry = `${prefix}${pinnedVersion}`;
    const pinned = matches.find(
      (entry) => entry === pinnedEntry || entry.startsWith(`${pinnedEntry}@`),
    );
    if (pinned) {
      return path.join(cacheDir, pinned);
    }
    console.warn(
      `[ensure-type-package-aliases] ${packageName}@${pinnedVersion} is pinned by bun.lock but not in the bun cache; keeping the installed copy`,
    );
    return null;
  }

  matches.sort((a, b) =>
    b.localeCompare(a, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

  return path.join(cacheDir, matches[0]);
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

function recreateTypeRoot(targetTypesDir) {
  removePathRecursive(targetTypesDir);
  mkdirSync(targetTypesDir, { recursive: true });
}

function ensureTypeRoot(targetTypesDir) {
  repairBrokenDirectoryLink(targetTypesDir);
  try {
    mkdirSync(targetTypesDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    recreateTypeRoot(targetTypesDir);
  }
}

function ensureTypeChildDir(targetTypesDir, childDir) {
  ensureTypeRoot(targetTypesDir);
  try {
    mkdirSync(childDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    recreateTypeRoot(targetTypesDir);
    mkdirSync(childDir, { recursive: true });
  }
}

function removeExistingTypeEntry(targetPath) {
  // A package manager may have linked a real @types/<pkg> here as a symlink.
  // fs.cpSync(force) does NOT overwrite a symlink dest (it throws EEXIST), and
  // rmSync(recursive) does not reliably clear a symlink-to-directory — so
  // unlink symlinks/files explicitly and only rm real directories.
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    removePathRecursive(targetPath);
  } else {
    unlinkSync(targetPath);
  }
}

function materializeTypePackage(targetTypesDir, packageName) {
  const pins = lockfilePinsFor(path.dirname(targetTypesDir));
  const sourceDir = findCachedTypePackageDir(
    packageName,
    pins.get(`@types/${packageName}`),
  );
  if (!sourceDir) {
    return false;
  }

  const targetDir = path.join(targetTypesDir, packageName);
  removeExistingTypeEntry(targetDir);
  ensureTypeRoot(targetTypesDir);
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
  });
  ensureTypeEntryPoint(targetDir, packageName);
  return true;
}

function materializePackage(targetNodeModulesDir, packageName) {
  const sourceDir = findCachedPackageDir(
    GLOBAL_PACKAGE_CACHE_DIR,
    packageName,
    lockfilePinsFor(targetNodeModulesDir).get(packageName),
  );
  if (!sourceDir || !existsSync(targetNodeModulesDir)) {
    return false;
  }

  const targetDir = path.join(targetNodeModulesDir, packageName);
  removeExistingTypeEntry(targetDir);
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
  });
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
  const bunTypesDir = path.join(targetTypesDir, "bun");
  const parentNodeModules = path.dirname(targetTypesDir);
  if (!existsSync(parentNodeModules)) {
    return;
  }
  ensureTypeChildDir(targetTypesDir, bunTypesDir);
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
  let materializedPackageCount = 0;
  const packageNames = [
    ...new Set([
      ...MATERIALIZED_TYPE_PACKAGES,
      ...collectBrokenBundledTypePackages(),
    ]),
  ].sort();

  for (const targetNodeModulesDir of NODE_MODULE_ROOTS) {
    for (const packageName of MATERIALIZED_PACKAGES) {
      if (materializePackage(targetNodeModulesDir, packageName)) {
        materializedPackageCount++;
      }
    }
  }

  for (const targetTypesDir of TYPE_ROOTS) {
    for (const packageName of packageNames) {
      if (materializeTypePackage(targetTypesDir, packageName)) {
        materializedCount++;
      }
    }
    ensureBunTypesAlias(targetTypesDir);
  }

  console.log(
    `[ensure-type-package-aliases] materialized ${materializedCount} @types package copies, ${materializedPackageCount} package copies, and refreshed Bun shims`,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  main();
}
