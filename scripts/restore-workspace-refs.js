#!/usr/bin/env node

/**
 * Restore workspace:* references after publishing.
 *
 * This script reverts the changes made by replace-workspace-versions.js,
 * restoring workspace:* for local development.
 *
 * Usage: node scripts/restore-workspace-refs.js [--dry-run]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose") || DRY_RUN;

// Get the workspace root
const workspaceRoot = dirname(dirname(new URL(import.meta.url).pathname));

// Read version from lerna.json
function getVersion() {
  const lernaPath = join(workspaceRoot, "lerna.json");
  const lerna = JSON.parse(readFileSync(lernaPath, "utf-8"));
  return lerna.version;
}

// Get all managed packages from lerna.json
function getManagedPackages() {
  const lernaPath = join(workspaceRoot, "lerna.json");
  const lerna = JSON.parse(readFileSync(lernaPath, "utf-8"));
  return lerna.packages || [];
}

// Expand glob patterns to actual package paths
function expandPackagePaths(patterns) {
  const packages = [];

  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      try {
        const expanded = execSync(
          `ls -d ${join(workspaceRoot, pattern)} 2>/dev/null || true`,
          {
            encoding: "utf-8",
          },
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        packages.push(...expanded);
      } catch {
        // Ignore glob expansion errors
      }
    } else {
      const fullPath = join(workspaceRoot, pattern);
      if (existsSync(fullPath)) {
        packages.push(fullPath);
      }
    }
  }

  return packages;
}

// Get all @elizaos package names from the workspace
function getWorkspacePackageNames(packagePaths) {
  const names = new Set();

  for (const pkgPath of packagePaths) {
    const pkgJsonPath = join(pkgPath, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (pkg.name?.startsWith("@elizaos/")) {
          names.add(pkg.name);
        }
      } catch {
        // Skip invalid package.json files
      }
    }
  }

  return names;
}

// Restore workspace:* references in a package.json
function restoreWorkspaceRefs(pkgJsonPath, version, workspacePackageNames) {
  const content = readFileSync(pkgJsonPath, "utf-8");
  const pkg = JSON.parse(content);
  let modified = false;
  const changes = [];

  const depTypes = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  for (const depType of depTypes) {
    if (!pkg[depType]) continue;

    for (const [depName, depVersion] of Object.entries(pkg[depType])) {
      // Only restore workspace:* for @elizaos packages that are part of this workspace
      // and currently have the release version
      if (
        workspacePackageNames.has(depName) &&
        typeof depVersion === "string" &&
        depVersion === version
      ) {
        pkg[depType][depName] = "workspace:*";
        changes.push(`  ${depType}.${depName}: ${version} → workspace:*`);
        modified = true;
      }
    }
  }

  if (modified) {
    if (VERBOSE) {
      console.log(`\n${pkgJsonPath}:`);
      for (const c of changes) {
        console.log(c);
      }
    }

    if (!DRY_RUN) {
      writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    }
  }

  return { modified, changes: changes.length };
}

// Main execution
function main() {
  console.log("🔄 Restoring workspace:* references...\n");

  const version = getVersion();
  console.log(`📦 Current version: ${version}`);

  if (DRY_RUN) {
    console.log("🏃 Dry run mode - no files will be modified\n");
  }

  const patterns = getManagedPackages();
  console.log(`📂 Package patterns: ${patterns.join(", ")}`);

  const packagePaths = expandPackagePaths(patterns);
  console.log(`📁 Found ${packagePaths.length} package directories\n`);

  const workspacePackageNames = getWorkspacePackageNames(packagePaths);
  console.log(
    `🏷️  Found ${workspacePackageNames.size} @elizaos packages in workspace\n`,
  );

  let totalModified = 0;
  let totalChanges = 0;

  for (const pkgPath of packagePaths) {
    const pkgJsonPath = join(pkgPath, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const { modified, changes } = restoreWorkspaceRefs(
        pkgJsonPath,
        version,
        workspacePackageNames,
      );
      if (modified) {
        totalModified++;
        totalChanges += changes;
      }
    } catch (err) {
      console.error(`❌ Error processing ${pkgJsonPath}: ${err.message}`);
    }
  }

  console.log(
    `\n✅ Done! Restored ${totalChanges} dependencies in ${totalModified} packages.`,
  );

  if (DRY_RUN) {
    console.log("\n💡 Run without --dry-run to apply changes.");
  }
}

main();
