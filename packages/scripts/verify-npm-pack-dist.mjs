#!/usr/bin/env node

/**
 * Verify npm dry-run pack output contains built dist artifacts.
 *
 * This catches release jobs that publish packages whose package.json points at
 * dist files but whose build artifacts were not materialized before publish.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));
const packageDirs = process.argv.slice(2);

if (packageDirs.length === 0) {
  console.error(
    "Usage: node packages/scripts/verify-npm-pack-dist.mjs <package-dir> [...]",
  );
  process.exit(1);
}

function normalizePackagePath(value) {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function collectDistReferences(value, references = new Set()) {
  if (typeof value === "string") {
    const normalized = normalizePackagePath(value);
    if (normalized.startsWith("dist/") && !normalized.includes("*")) {
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

function expectsDist(pkg) {
  if (
    Array.isArray(pkg.files) &&
    pkg.files.some((entry) => {
      const normalized = normalizePackagePath(String(entry)).replace(/\/$/, "");
      return normalized === "dist" || normalized.startsWith("dist/");
    })
  ) {
    return true;
  }

  return (
    collectDistReferences({
      main: pkg.main,
      module: pkg.module,
      types: pkg.types,
      exports: pkg.exports,
    }).size > 0
  );
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

let failed = false;

for (const packageDir of packageDirs) {
  const absoluteDir = join(repoRoot, packageDir);
  const packageJsonPath = join(absoluteDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    console.error(
      `Missing package.json: ${relative(repoRoot, packageJsonPath)}`,
    );
    failed = true;
    continue;
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!expectsDist(pkg)) {
    console.log(
      `skip ${pkg.name ?? packageDir}: package does not declare dist`,
    );
    continue;
  }

  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
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
  const hasDist = [...files].some((file) => file.startsWith("dist/"));
  const missingReferences = [...collectDistReferences(pkg)].filter(
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
