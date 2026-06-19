#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesRoot = join(repoRoot, "packages");

const sourceTag = process.argv[2] || "beta";
const targetTag = process.argv[3] || "next";

function walkPackageJsonFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "target" ||
      entry.name === ".turbo"
    ) {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      walkPackageJsonFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

function runNpm(args, { allowFailure = false } = {}) {
  const result = spawnSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return result.stdout.trim();
  }

  if (allowFailure) {
    return "";
  }

  const stderr = result.stderr.trim();
  throw new Error(stderr || `npm ${args.join(" ")} failed`);
}

function collectManagedPackages() {
  const names = new Map();

  for (const packageJsonPath of walkPackageJsonFiles(packagesRoot)) {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);

    if (pkg.private === true || typeof pkg.name !== "string") {
      continue;
    }

    if (!pkg.name.startsWith("@elizaos/")) {
      continue;
    }

    names.set(pkg.name, relative(repoRoot, packageJsonPath));
  }

  return [...names.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const packages = collectManagedPackages();
let updated = 0;

console.log(
  `Syncing dist-tags for ${packages.length} package(s): ${sourceTag} -> ${targetTag}`,
);

for (const [packageName, packageJsonPath] of packages) {
  const rawTags = runNpm(["view", packageName, "dist-tags", "--json"], {
    allowFailure: true,
  });

  if (!rawTags) {
    console.log(
      `- skip ${packageName} (${packageJsonPath}): no dist-tags found`,
    );
    continue;
  }

  let tags;
  try {
    tags = JSON.parse(rawTags);
  } catch (_error) {
    console.log(
      `- skip ${packageName} (${packageJsonPath}): invalid dist-tags`,
    );
    continue;
  }

  const sourceVersion = tags[sourceTag];
  if (!sourceVersion) {
    console.log(
      `- skip ${packageName} (${packageJsonPath}): no ${sourceTag} tag`,
    );
    continue;
  }

  if (tags[targetTag] === sourceVersion) {
    console.log(`- ok   ${packageName}: ${targetTag} already ${sourceVersion}`);
    continue;
  }

  runNpm(["dist-tag", "add", `${packageName}@${sourceVersion}`, targetTag]);
  updated += 1;
  console.log(
    `- set  ${packageName}: ${targetTag} -> ${sourceVersion} (from ${sourceTag})`,
  );
}

console.log(`Done. Updated ${updated} package(s).`);
