#!/usr/bin/env node
/**
 * Replace workspace:* / workspace:^ / workspace:~ on in-repo packages with each
 * target package's version (from its package.json). For npm publish / tarball
 * workflows where workspace: protocols are invalid.
 *
 * eliza uses a single lerna version; Eliza uses per-package versions.
 *
 * Usage: bun scripts/replace-workspace-versions.mjs [--dry-run] [--verbose]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRepoRootFromImportMeta(import.meta.url);

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose") || DRY_RUN;

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const patterns = rootPkg.workspaces || [];
const { workspaceDirs, nameToVersion } = collectWorkspaceMaps(ROOT, patterns);

function isWorkspaceProtocol(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

function replaceInPackage(pkgJsonPath) {
  const raw = readFileSync(pkgJsonPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { modified: false, changes: 0 };
  }

  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  let modified = false;
  let changes = 0;
  const logLines = [];

  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) {
      continue;
    }
    for (const [depName, depVersion] of Object.entries(pkg[section])) {
      if (!isWorkspaceProtocol(depVersion)) {
        continue;
      }
      const targetVersion = nameToVersion.get(depName);
      if (!targetVersion) {
        continue;
      }
      pkg[section][depName] = targetVersion;
      changes++;
      modified = true;
      logLines.push(
        `  ${section}.${depName}: ${depVersion} → ${targetVersion}`,
      );
    }
  }

  if (modified && VERBOSE) {
    console.log(`\n${relative(ROOT, pkgJsonPath)}:`);
    for (const line of logLines) {
      console.log(line);
    }
  }

  if (modified && !DRY_RUN) {
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify(pkg, null, indent)}\n`,
      "utf8",
    );
  }

  return { modified, changes };
}

function main() {
  console.log(
    "Replacing workspace: references with pinned versions (per workspace package)…\n",
  );

  if (DRY_RUN) {
    console.log("Dry run — no files will be modified\n");
  }

  let totalModified = 0;
  let totalChanges = 0;

  for (const dir of workspaceDirs) {
    const pkgJsonPath = join(dir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    try {
      const { modified, changes } = replaceInPackage(pkgJsonPath);
      if (modified) {
        totalModified++;
      }
      totalChanges += changes;
    } catch (err) {
      console.error(`Error processing ${pkgJsonPath}: ${err?.message ?? err}`);
    }
  }

  console.log(
    `\nDone. ${totalChanges} dependency update(s) in ${totalModified} package(s).`,
  );
  if (DRY_RUN && totalChanges > 0) {
    console.log("\nRun without --dry-run to apply.");
  }
}

main();
