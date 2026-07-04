#!/usr/bin/env node
// Drives repo automation typecheck dist path consumers with explicit CLI and CI behavior.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const distPathsConfig = path.join(repoRoot, "tsconfig.dist-paths.json");
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

const localTsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const tsc = existsSync(localTsc) ? localTsc : "tsc";

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (/^tsconfig(?:\..*)?\.json$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function readExtends(configPath) {
  const body = readFileSync(configPath, "utf8");
  const match = body.match(/"extends"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

function extendsDistPaths(configPath) {
  const extendsValue = readExtends(configPath);
  if (!extendsValue) return false;
  return (
    path.resolve(path.dirname(configPath), extendsValue) === distPathsConfig
  );
}

const configs = walk(repoRoot).filter(extendsDistPaths).sort();

if (process.argv.includes("--list")) {
  for (const config of configs) {
    console.log(path.relative(repoRoot, config));
  }
  process.exit(0);
}

if (configs.length === 0) {
  console.error("[typecheck:dist] no tsconfig.dist-paths.json consumers found");
  process.exit(1);
}

for (const config of configs) {
  const rel = path.relative(repoRoot, config);
  console.log(`\n[typecheck:dist] ${rel}`);
  const result = spawnSync(
    tsc,
    ["--noEmit", "--pretty", "false", "-p", config],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(
      `[typecheck:dist] failed to start ${tsc}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[typecheck:dist] failed in ${rel} with exit code ${result.status}`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(
  `\n[typecheck:dist] checked ${configs.length} dist-path consumer config(s)`,
);
