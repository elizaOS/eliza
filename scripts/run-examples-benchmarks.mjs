#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error("Usage: node scripts/run-examples-benchmarks.mjs <script>");
  process.exit(1);
}

const root = process.cwd();
const roots = ["packages/examples", "packages/benchmarks"];
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

function collectPackageJsons(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) continue;
    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      collectPackageJsons(fullPath, out);
      continue;
    }
    if (name === "package.json") {
      out.push(fullPath);
    }
  }
  return out;
}

const packages = roots
  .flatMap((entry) => collectPackageJsons(path.join(root, entry)))
  .sort()
  .map((packageJsonPath) => {
    const packageDir = path.dirname(packageJsonPath);
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return {
      dir: packageDir,
      name: manifest.name ?? path.relative(root, packageDir),
      scripts: manifest.scripts ?? {},
    };
  })
  .filter((pkg) => Object.hasOwn(pkg.scripts, scriptName));

// Some benchmark/example packages live outside the workspace globs in
// the root package.json (e.g. packages/benchmarks/gauntlet/sdk/typescript)
// and therefore have no node_modules of their own. Building those is
// best-effort — fail individual packages but keep going so a stale
// benchmark doesn't block the whole repo build.
const failures = [];
for (const pkg of packages) {
  const relativeDir = path.relative(root, pkg.dir);
  console.log(`\n[${scriptName}] ${pkg.name} (${relativeDir})`);
  const result = spawnSync("bun", ["run", scriptName], {
    cwd: pkg.dir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      `[${scriptName}] failed in ${relativeDir} with exit code ${result.status} — continuing`,
    );
    failures.push({ pkg: pkg.name, dir: relativeDir, code: result.status });
  }
}

if (failures.length > 0) {
  console.error(
    `\n[${scriptName}] ${failures.length} package(s) failed:`,
  );
  for (const failure of failures) {
    console.error(
      `  - ${failure.pkg} (${failure.dir}) exit=${failure.code}`,
    );
  }
  // Hard-fail only when ALL packages failed.
  if (failures.length === packages.length) {
    process.exit(1);
  }
}

process.exit(0);
