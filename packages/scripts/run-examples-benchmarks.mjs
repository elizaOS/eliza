#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error("Usage: node packages/scripts/run-examples-benchmarks.mjs <script>");
  process.exit(1);
}

const root = process.cwd();
const roots = ["packages/examples", "packages/benchmarks"];
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
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

let failed = false;
for (const pkg of packages) {
  const relativeDir = path.relative(root, pkg.dir);
  console.log(`\n[${scriptName}] ${pkg.name} (${relativeDir})`);
  const result = spawnSync("bun", ["run", scriptName], {
    cwd: pkg.dir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(
      `[${scriptName}] failed in ${relativeDir} with exit code ${result.status}`,
    );
    break;
  }
}

process.exit(failed ? 1 : 0);
