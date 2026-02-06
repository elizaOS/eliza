#!/usr/bin/env node

/**
 * Replace workspace:* references with actual version numbers before publishing.
 *
 * This script is necessary because:
 * 1. Bun workspaces use `workspace:*` protocol for local package references
 * 2. When publishing to npm, these need to be replaced with actual versions
 * 3. Lerna's `from-package` mode doesn't automatically handle this with Bun
 *
 * Usage: node scripts/replace-workspace-versions.js [--dry-run]
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
      // Use shell glob expansion
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

// Replace workspace:* references in a package.json
function replaceWorkspaceRefs(pkgJsonPath, version, workspacePackageNames) {
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
      // Only replace workspace:* for @elizaos packages that are part of this workspace
      if (
        typeof depVersion === "string" &&
        depVersion.startsWith("workspace:") &&
        workspacePackageNames.has(depName)
      ) {
        const newVersion = version;
        pkg[depType][depName] = newVersion;
        changes.push(`  ${depType}.${depName}: workspace:* → ${newVersion}`);
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
      // Preserve formatting by re-serializing with 2-space indent
      writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    }
  }

  return { modified, changes: changes.length };
}

// Main execution
function main() {
  console.log("🔄 Replacing workspace:* references with actual versions...\n");

  const version = getVersion();
  console.log(`📦 Target version: ${version}`);

  if (DRY_RUN) {
    console.log("🏃 Dry run mode - no files will be modified\n");
  }

  const patterns = getManagedPackages();
  console.log(`📂 Package patterns: ${patterns.join(", ")}`);

  const packagePaths = expandPackagePaths(patterns);
  console.log(`📁 Found ${packagePaths.length} package directories\n`);

  // Get all workspace package names
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
      const { modified, changes } = replaceWorkspaceRefs(
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
    `\n✅ Done! Modified ${totalModified} packages with ${totalChanges} dependency updates.`,
  );

  if (DRY_RUN) {
    console.log("\n💡 Run without --dry-run to apply changes.");
  }
}

main();
