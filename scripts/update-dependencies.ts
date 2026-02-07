#!/usr/bin/env bun

/**
 * Script to update all dependencies across TypeScript, Python, and Rust packages
 * Ensures version consistency for common dependencies
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
  overrides?: Record<string, string>;
}

// Standard versions for common dependencies
const STANDARD_VERSIONS: Record<string, string> = {
  // TypeScript tooling
  typescript: "^5.9.3",
  "@types/node": "^25.0.3",
  "@types/bun": "^1.3.5",
  "@types/uuid": "^11.0.0",
  "@types/react": "19.2.3",

  // Testing
  vitest: "^4.0.0",
  "@vitest/coverage-v8": "^4.0.0",

  // Core dependencies
  zod: "^4.3.5",
  uuid: "^13.0.0",
  dotenv: "^17.2.3",

  // Build tools
  prettier: "^3.7.4",
  turbo: "^2.7.3",
  lerna: "9.0.3",

  // React (from resolutions)
  react: "19.2.3",
  "react-dom": "19.2.3",
};

// @elizaos/* packages should use workspace:*
const _ELIZAOS_PACKAGES = [
  "@elizaos/core",
  "@elizaos/plugin-",
  "@elizaos/client",
  "@elizaos/server",
];

async function updatePackageJson(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf-8");
    const pkg: PackageJson = JSON.parse(content);
    let modified = false;

    // Update dependencies
    if (pkg.dependencies) {
      for (const [dep, version] of Object.entries(pkg.dependencies)) {
        // Standardize @elizaos/* packages to workspace:*
        if (dep.startsWith("@elizaos/")) {
          if (version !== "workspace:*") {
            pkg.dependencies[dep] = "workspace:*";
            modified = true;
            console.log(`  Updated ${dep}: ${version} -> workspace:*`);
          }
        }
        // Update standard versions
        else if (STANDARD_VERSIONS[dep] && version !== STANDARD_VERSIONS[dep]) {
          const oldVersion = version;
          pkg.dependencies[dep] = STANDARD_VERSIONS[dep];
          modified = true;
          console.log(
            `  Updated ${dep}: ${oldVersion} -> ${STANDARD_VERSIONS[dep]}`,
          );
        }
      }
    }

    // Update devDependencies
    if (pkg.devDependencies) {
      for (const [dep, version] of Object.entries(pkg.devDependencies)) {
        if (STANDARD_VERSIONS[dep] && version !== STANDARD_VERSIONS[dep]) {
          const oldVersion = version;
          pkg.devDependencies[dep] = STANDARD_VERSIONS[dep];
          modified = true;
          console.log(
            `  Updated ${dep}: ${oldVersion} -> ${STANDARD_VERSIONS[dep]}`,
          );
        }
      }
    }

    // Update peerDependencies
    if (pkg.peerDependencies) {
      for (const [dep, version] of Object.entries(pkg.peerDependencies)) {
        if (dep.startsWith("@elizaos/") && version !== "workspace:*") {
          pkg.peerDependencies[dep] = "workspace:*";
          modified = true;
          console.log(`  Updated peer ${dep}: ${version} -> workspace:*`);
        }
      }
    }

    if (modified) {
      await writeFile(filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return false;
  }
}

async function main() {
  console.log("Updating TypeScript/Node.js dependencies...\n");

  const packageJsonFiles = await glob("**/package.json", {
    ignore: ["**/node_modules/**", "**/.turbo/**", "**/dist/**"],
    cwd: process.cwd(),
  });

  let updatedCount = 0;
  for (const file of packageJsonFiles) {
    const fullPath = join(process.cwd(), file);
    console.log(`Processing ${file}...`);
    if (await updatePackageJson(fullPath)) {
      updatedCount++;
      console.log(`  ✓ Updated\n`);
    } else {
      console.log(`  - No changes needed\n`);
    }
  }

  console.log(`\n✓ Updated ${updatedCount} package.json files`);
}

main().catch(console.error);
