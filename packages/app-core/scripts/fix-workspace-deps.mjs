#!/usr/bin/env node
/**
 * fix-workspace-deps.mjs
 *
 * Same idea as eliza's scripts/fix-workspace-deps.mjs:
 *
 * LOCAL (default): rewrite dependencies on in-repo workspace packages to "workspace:*"
 * CHECK (--check): exit 1 if any such dep is not "workspace:*" (CI)
 * RESTORE (--restore): restore original version strings from a git ref (default HEAD)
 *
 * Usage:
 *   bun scripts/fix-workspace-deps.mjs
 *   bun scripts/fix-workspace-deps.mjs --check
 *   bun scripts/fix-workspace-deps.mjs --restore
 *   bun scripts/fix-workspace-deps.mjs --restore --ref origin/main
 *
 * Why this exists: Eliza often uses repo-local ./eliza and plugins/* checkouts.
 * Running upstream tooling or hand-editing package.json leaves semver pins where
 * workspace:* is required (or the reverse). Normalizing in one place avoids
 * "Cannot find module" and review-noise from inconsistent edges across 50+ packages.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRepoRootFromImportMeta(import.meta.url);

const CHECK_MODE = process.argv.includes("--check");
const RESTORE_MODE = process.argv.includes("--restore");
const QUIET = process.argv.includes("--quiet");

function getRestoreRef() {
  const idx = process.argv.indexOf("--ref");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return "HEAD";
}

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const patterns = rootPkg.workspaces || [];
const { workspaceDirs, nameToDir } = collectWorkspaceMaps(ROOT, patterns);

const isWorkspacePackage = (depName) => nameToDir.has(depName);

if (!QUIET) {
  console.log(`Workspace packages: ${nameToDir.size}`);
  console.log(`package.json files to scan: ${workspaceDirs.length}`);
  const mode = RESTORE_MODE
    ? "restore (from git)"
    : CHECK_MODE
      ? "check (read-only)"
      : "fix (→ workspace:*)";
  console.log(`Mode: ${mode}\n`);
}

function gitShowFile(ref, filePath) {
  const relPath = relative(ROOT, filePath);
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

// ── RESTORE ─────────────────────────────────────────────────────────────────

if (RESTORE_MODE) {
  const ref = getRestoreRef();
  if (!QUIET) {
    console.log(`Restoring from git ref: ${ref}\n`);
  }

  let restoreCount = 0;
  let skipCount = 0;
  let newDepCount = 0;

  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      continue;
    }
    const raw = readFileSync(pkgPath, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }

    const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
    const rel = relative(ROOT, pkgPath);
    let changed = false;

    const oldRaw = gitShowFile(ref, pkgPath);
    let oldPkg = null;
    if (oldRaw) {
      try {
        oldPkg = JSON.parse(oldRaw);
      } catch {
        // skip
      }
    }

    for (const section of DEP_SECTIONS) {
      if (!pkg[section]) {
        continue;
      }
      for (const [depName, depVersion] of Object.entries(pkg[section])) {
        if (depVersion !== "workspace:*") {
          continue;
        }
        if (!isWorkspacePackage(depName)) {
          continue;
        }

        const oldVersion = oldPkg?.[section]?.[depName];

        if (oldVersion && oldVersion !== "workspace:*") {
          if (!QUIET) {
            console.log(
              `  restore ${rel} ${section}.${depName}: "workspace:*" → "${oldVersion}"`,
            );
          }
          pkg[section][depName] = oldVersion;
          changed = true;
          restoreCount++;
        } else if (!oldVersion && oldPkg) {
          if (!QUIET) {
            console.log(
              `  new ${rel} ${section}.${depName}: "workspace:*" (no original — set version manually)`,
            );
          }
          newDepCount++;
        } else {
          skipCount++;
        }
      }
    }

    if (changed) {
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf8");
    }
  }

  console.log("");
  const parts = [];
  if (restoreCount > 0) {
    parts.push(`${restoreCount} dep(s) restored`);
  }
  if (newDepCount > 0) {
    parts.push(
      `${newDepCount} new dep(s) left as workspace:* (set versions manually)`,
    );
  }
  if (skipCount > 0) {
    parts.push(`${skipCount} already correct`);
  }
  if (parts.length > 0) {
    console.log(`Done: ${parts.join(", ")}.`);
  } else {
    console.log(
      "Nothing to restore — no workspace:* refs found for workspace packages.",
    );
  }
  if (restoreCount > 0) {
    console.log("\nRemember to run `bun install` to update the lockfile.");
  }

  process.exit(0);
}

// ── FIX / CHECK ─────────────────────────────────────────────────────────────

let fixCount = 0;
const issues = [];

for (const dir of workspaceDirs) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    continue;
  }
  const raw = readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    continue;
  }

  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  const selfName = pkg.name;
  let changed = false;
  const rel = relative(ROOT, pkgPath);

  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) {
      continue;
    }
    for (const [depName, depVersion] of Object.entries(pkg[section])) {
      if (!isWorkspacePackage(depName)) {
        continue;
      }
      if (depName === selfName) {
        continue;
      }
      if (depVersion === "workspace:*") {
        continue;
      }

      if (CHECK_MODE) {
        issues.push(
          `${rel} ${section}.${depName}: "${depVersion}" (should be "workspace:*")`,
        );
      } else {
        if (!QUIET) {
          console.log(
            `  fix ${rel} ${section}.${depName}: "${depVersion}" → "workspace:*"`,
          );
        }
        pkg[section][depName] = "workspace:*";
        changed = true;
      }
      fixCount++;
    }
  }

  if (changed) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf8");
  }
}

let removeCount = 0;
const danglingIssues = [];

for (const dir of workspaceDirs) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    continue;
  }
  const raw = readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    continue;
  }

  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  const rel = relative(ROOT, pkgPath);
  let changed = false;

  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) {
      continue;
    }
    for (const [depName, depVersion] of Object.entries(pkg[section])) {
      if (depVersion === "workspace:*" && !nameToDir.has(depName)) {
        if (CHECK_MODE) {
          danglingIssues.push(
            `${rel} ${section}.${depName}: "workspace:*" references nonexistent package`,
          );
        } else {
          if (!QUIET) {
            console.log(
              `  rm ${rel} ${section}.${depName}: "workspace:*" (package not in workspace)`,
            );
          }
          delete pkg[section][depName];
          changed = true;
        }
        removeCount++;
      }
    }
  }

  if (changed) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf8");
  }
}

console.log("");
const totalIssues = fixCount + removeCount;

if (CHECK_MODE) {
  if (totalIssues > 0) {
    console.log(`FAIL: ${totalIssues} issue(s) found:\n`);
    for (const issue of [...issues, ...danglingIssues]) {
      console.log(`  ${issue}`);
    }
    console.log("\nRun `bun run workspace:deps:sync` to fix them.");
    process.exit(1);
  }
  console.log(
    `OK: all workspace references look correct (${nameToDir.size} packages).`,
  );
} else {
  const parts = [];
  if (fixCount > 0) {
    parts.push(`${fixCount} version(s) → workspace:*`);
  }
  if (removeCount > 0) {
    parts.push(`${removeCount} dangling ref(s) removed`);
  }
  if (parts.length > 0) {
    console.log(`Done: ${parts.join(", ")}.`);
  } else {
    console.log(
      "All workspace references are already correct. Nothing to fix.",
    );
  }
}
