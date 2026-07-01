#!/usr/bin/env node

/**
 * Verify npm dry-run pack output contains built dist artifacts.
 *
 * This catches release jobs that publish packages whose package.json points at
 * dist files but whose build artifacts were not materialized before publish.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));
const args = process.argv.slice(2);
const packageDirs = [];
let allPublicDistPackages = false;
let buildBeforePack = false;

for (const arg of args) {
  if (arg === "--all-public-dist-packages") {
    allPublicDistPackages = true;
  } else if (arg === "--build") {
    buildBeforePack = true;
  } else {
    packageDirs.push(arg);
  }
}

if (packageDirs.length === 0 && !allPublicDistPackages) {
  console.error(
    "Usage: node packages/scripts/verify-npm-pack-dist.mjs [--build] [--all-public-dist-packages | <package-dir> [...]]",
  );
  process.exit(1);
}

function normalizePackagePath(value) {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function isDistArtifactPath(value) {
  const normalized = normalizePackagePath(value);
  return normalized.startsWith("dist/") || normalized.includes("/dist/");
}

function isDistDirectoryReference(value) {
  const normalized = normalizePackagePath(value).replace(/\/$/, "");
  return normalized === "dist" || normalized.endsWith("/dist");
}

function collectDistReferences(value, references = new Set()) {
  if (typeof value === "string") {
    const normalized = normalizePackagePath(value);
    if (
      isDistArtifactPath(normalized) &&
      !isDistDirectoryReference(normalized) &&
      !normalized.includes("*")
    ) {
      references.add(normalized);
    }
    return references;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectDistReferences(item, references);
    }
    return references;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectDistReferences(item, references);
    }
  }

  return references;
}

function collectEntryPointDistReferences(pkg) {
  return collectDistReferences({
    main: pkg.main,
    module: pkg.module,
    types: pkg.types,
    bin: pkg.bin,
    exports: pkg.exports,
  });
}

function expectsDist(pkg) {
  return collectEntryPointDistReferences(pkg).size > 0;
}

function expandLernaPackagePattern(pattern) {
  if (!pattern.includes("*")) {
    return [pattern];
  }

  const [baseDir, suffix = ""] = pattern.split("*");
  const normalizedBase = baseDir.replace(/\/$/, "");
  const absoluteBase = join(repoRoot, normalizedBase);
  if (!existsSync(absoluteBase)) {
    return [];
  }

  return readdirSync(absoluteBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      join(normalizedBase, entry.name, suffix.replace(/^\//, "")).replace(
        /\\/g,
        "/",
      ),
    );
}

function isTrackedPackageManifest(packageJsonPath) {
  try {
    execFileSync(
      "git",
      ["ls-files", "--error-unmatch", relative(repoRoot, packageJsonPath)],
      {
        cwd: repoRoot,
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

function discoverPublicPackageDirs() {
  const lerna = JSON.parse(readFileSync(join(repoRoot, "lerna.json"), "utf8"));
  const dirs = new Set();

  for (const pattern of lerna.packages ?? []) {
    for (const packageDir of expandLernaPackagePattern(pattern)) {
      const packageJsonPath = join(repoRoot, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      if (!isTrackedPackageManifest(packageJsonPath)) {
        continue;
      }

      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (pkg.private === true) {
        continue;
      }

      dirs.add(packageDir);
    }
  }

  return [...dirs].sort();
}

function readPackageInfo(packageDir) {
  const absoluteDir = join(repoRoot, packageDir);
  const packageJsonPath = join(absoluteDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Missing package.json: ${relative(repoRoot, packageJsonPath)}`,
    );
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return {
    absoluteDir,
    packageDir,
    pkg,
    expectsDist: expectsDist(pkg),
  };
}

function parsePackJson(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[\s*\{\s*"id"[\s\S]*\]\s*$/);
    if (!match) {
      throw new Error(`Unable to parse npm pack JSON output:\n${trimmed}`);
    }
    return JSON.parse(match[0]);
  }
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    const npmCliPath = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (existsSync(npmCliPath)) {
      return { command: process.execPath, args: [npmCliPath, ...args] };
    }
  }
  return { command: "npm", args };
}

if (allPublicDistPackages) {
  for (const packageDir of discoverPublicPackageDirs()) {
    if (!packageDirs.includes(packageDir)) {
      packageDirs.push(packageDir);
    }
  }
}

const packageInfos = [];
let failed = false;

for (const packageDir of packageDirs) {
  try {
    packageInfos.push(readPackageInfo(packageDir));
  } catch (error) {
    console.error(error.message);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

const distPackageInfos = packageInfos.filter((info) => info.expectsDist);

if (buildBeforePack && distPackageInfos.length > 0) {
  const buildFilters = distPackageInfos
    .filter((info) => info.pkg.scripts?.build)
    .map((info) => `--filter=${info.pkg.name}`);

  if (buildFilters.length > 0) {
    console.log(
      `Building ${buildFilters.length} package(s) before npm pack verification...`,
    );
    execFileSync(
      "bunx",
      ["turbo", "run", "build", "--continue", ...buildFilters],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
  }
}

for (const info of packageInfos) {
  const { absoluteDir, packageDir, pkg } = info;
  if (!info.expectsDist) {
    console.log(
      `skip ${pkg.name ?? packageDir}: package does not declare dist`,
    );
    continue;
  }

  const npm = npmInvocation(["pack", "--dry-run", "--json"]);
  const output = execFileSync(npm.command, npm.args, {
    cwd: absoluteDir,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_loglevel: "error",
    },
  });
  const pack = parsePackJson(output);
  const files = new Set(
    (pack[0]?.files ?? []).map((file) => normalizePackagePath(file.path)),
  );
  const hasDist = [...files].some((file) => isDistArtifactPath(file));
  const missingReferences = [...collectEntryPointDistReferences(pkg)].filter(
    (file) => !files.has(file),
  );

  if (!hasDist || missingReferences.length > 0) {
    failed = true;
    console.error(
      `Package ${pkg.name ?? packageDir} dry-run pack is missing dist artifacts.`,
    );
    if (!hasDist) {
      console.error("  - no dist/** files were included in the tarball");
    }
    for (const file of missingReferences) {
      console.error(`  - missing referenced file: ${file}`);
    }
    continue;
  }

  console.log(
    `ok ${pkg.name ?? packageDir}: ${files.size} packed file(s), dist included`,
  );
}

if (failed) {
  process.exit(1);
}
