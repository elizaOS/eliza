#!/usr/bin/env node

/**
 * fix-workspace-deps.mjs
 *
 * Enforces workspace dependency references in the monorepo. Two modes:
 *
 *   SOURCE mode (default):
 *     Rewrites every workspace dependency to "workspace:*" so bun resolves
 *     to the local package. This is the committed source state.
 *
 *   RESTORE mode (--restore):
 *     Reads old version strings from a git ref and puts them back, reversing
 *     the workspace:* conversion WITHOUT touching other changes. Use only for
 *     explicit publish/deploy compatibility work that needs registry specs.
 *
 * Usage:
 *   node scripts/fix-workspace-deps.mjs                  # set workspace:*
 *   node scripts/fix-workspace-deps.mjs --check          # CI — exit 1 if any need fixing
 *   node scripts/fix-workspace-deps.mjs --restore        # restore from HEAD
 *   node scripts/fix-workspace-deps.mjs --restore --ref HEAD~3  # restore from specific ref
 *
 * Workflow:
 *   1. Pull/clone
 *   2. `bun run fix-deps:check` verifies local packages use workspace:*
 *   3. `bun run fix-deps` repairs drift if a manifest picked up a registry pin
 *   4. Publish/deploy tooling materializes exact npm versions at the boundary
 *
 * Git submodule plugins (plugins/*) can drift to registry pins from their
 * standalone repos. The dev flow adds their typescript/ paths to workspaces and
 * runs this script so the checked-out monorepo graph stays workspace-local.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");
const CHECK_MODE = process.argv.includes("--check");
const RESTORE_MODE = process.argv.includes("--restore");
const QUIET = process.argv.includes("--quiet");

// For --restore, which git ref to read originals from (default: HEAD)
function getRestoreRef() {
  const idx = process.argv.indexOf("--ref");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return "HEAD";
}

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"];

// ── Glob expansion ──────────────────────────────────────────────────────────

/**
 * Expand a single workspace pattern (e.g. "plugins/plugin-*")
 * into a list of directories that actually exist and contain a package.json.
 */
function expandPattern(pattern) {
  const dirs = [];
  const parts = pattern.split("/");

  function walk(base, partIndex) {
    if (partIndex >= parts.length) {
      if (existsSync(join(base, "package.json"))) {
        dirs.push(base);
      }
      return;
    }

    const segment = parts[partIndex];

    if (segment.includes("*")) {
      // Glob segment — list the directory and match
      if (!existsSync(base) || !statSync(base).isDirectory()) return;
      const regex = new RegExp(
        "^" + segment.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      for (const entry of readdirSync(base)) {
        // Never walk into node_modules, dist, or hidden directories
        if (
          entry === "node_modules" ||
          entry === "dist" ||
          entry.startsWith(".")
        )
          continue;
        if (regex.test(entry)) {
          const full = join(base, entry);
          if (statSync(full).isDirectory()) {
            walk(full, partIndex + 1);
          }
        }
      }
    } else {
      // Literal segment — but still skip node_modules
      if (segment === "node_modules") return;
      walk(join(base, segment), partIndex + 1);
    }
  }

  walk(ROOT, 0);
  return dirs;
}

// ── Main ────────────────────────────────────────────────────────────────────

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const patterns = rootPkg.workspaces || [];

// 1. Discover all workspace directories and package names (dedup overlapping globs)
function collectWorkspaceDirs(patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    for (const dir of expandPattern(pattern)) {
      dirs.add(dir);
    }
  }
  dirs.add(ROOT); // Always include the root itself
  return Array.from(dirs);
}

const workspaceDirs = collectWorkspaceDirs(patterns);

const nameToDir = new Map(); // package name -> directory
for (const dir of workspaceDirs) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.name) {
      nameToDir.set(pkg.name, dir);
    }
  } catch {
    // skip unparseable
  }
}

const isWorkspacePackage = (depName) => nameToDir.has(depName);

if (!QUIET) {
  console.log(`Workspace packages: ${nameToDir.size}`);
  console.log(`Package.json files to scan: ${workspaceDirs.length}`);
  const mode = RESTORE_MODE
    ? "restore (from git)"
    : CHECK_MODE
      ? "check (read-only)"
      : "fix (→ workspace:*)";
  console.log(`Mode: ${mode}\n`);
}

// ── Helper: read a file from a git ref ──────────────────────────────────────

function gitShowFile(ref, filePath) {
  const relPath = relative(ROOT, filePath);
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null; // file doesn't exist at that ref
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE MODE — put back the original versions from a git ref
// ─────────────────────────────────────────────────────────────────────────────

if (RESTORE_MODE) {
  const ref = getRestoreRef();
  if (!QUIET) console.log(`Restoring from git ref: ${ref}\n`);

  let restoreCount = 0;
  let skipCount = 0;
  let newDepCount = 0;

  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }

    const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
    const rel = relative(ROOT, pkgPath);
    let changed = false;

    // Read the old version of this file from git
    const oldRaw = gitShowFile(ref, pkgPath);
    let oldPkg = null;
    if (oldRaw) {
      try {
        oldPkg = JSON.parse(oldRaw);
      } catch {
        // unparseable at that ref, skip
      }
    }

    for (const section of DEP_SECTIONS) {
      if (!pkg[section]) continue;

      for (const [depName, depVersion] of Object.entries(pkg[section])) {
        // Only restore workspace:* refs for packages that exist in the workspace
        if (depVersion !== "workspace:*") continue;
        if (!isWorkspacePackage(depName)) continue;

        // Look up the original version from the git ref
        const oldVersion = oldPkg?.[section]?.[depName];

        if (oldVersion && oldVersion !== "workspace:*") {
          if (!QUIET) {
            console.log(
              `  restore  ${rel}  ${section}.${depName}: "workspace:*" → "${oldVersion}"`,
            );
          }
          pkg[section][depName] = oldVersion;
          changed = true;
          restoreCount++;
        } else if (!oldVersion && oldPkg) {
          // Dep didn't exist at the old ref — it was added by us. Keep workspace:*
          // but warn so the developer can set a proper version.
          if (!QUIET) {
            console.log(
              `  new      ${rel}  ${section}.${depName}: "workspace:*" (no original — set version manually)`,
            );
          }
          newDepCount++;
        } else {
          // Old file didn't exist at all, or old also had workspace:* — skip silently
          skipCount++;
        }
      }
    }

    if (changed) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
    }
  }

  console.log("");
  const parts = [];
  if (restoreCount > 0) parts.push(`${restoreCount} dep(s) restored`);
  if (newDepCount > 0)
    parts.push(
      `${newDepCount} new dep(s) left as workspace:* (set versions manually)`,
    );
  if (skipCount > 0) parts.push(`${skipCount} already correct`);
  if (parts.length > 0) {
    console.log(`Done: ${parts.join(", ")}.`);
  } else {
    console.log(
      `Nothing to restore — no workspace:* refs found for workspace packages.`,
    );
  }
  if (restoreCount > 0) {
    console.log(`\nRemember to run \`bun install\` to update the lockfile.`);
  }

  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX MODE (default) — set workspace:* for local dev
// ─────────────────────────────────────────────────────────────────────────────

// 2. Scan and fix
let fixCount = 0;
const issues = []; // for --check summary

for (const dir of workspaceDirs) {
  const pkgPath = join(dir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    continue;
  }

  // Detect indentation to preserve formatting
  const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";

  const selfName = pkg.name;
  let changed = false;
  const rel = relative(ROOT, pkgPath);

  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) continue;

    for (const [depName, depVersion] of Object.entries(pkg[section])) {
      // Only care about packages that exist in this workspace
      if (!isWorkspacePackage(depName)) continue;

      // Skip self-references (shouldn't happen but be safe)
      if (depName === selfName) continue;

      // Already correct
      if (depVersion === "workspace:*") continue;

      if (CHECK_MODE) {
        issues.push(
          `${rel}  ${section}.${depName}: "${depVersion}" (should be "workspace:*")`,
        );
      } else {
        if (!QUIET) {
          console.log(
            `  fix  ${rel}  ${section}.${depName}: "${depVersion}" → "workspace:*"`,
          );
        }
        pkg[section][depName] = "workspace:*";
        changed = true;
      }
      fixCount++;
    }
  }

  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
  }
}

// 3. Find and fix dangling workspace:* refs to packages that don't exist
//    (e.g. "@elizaos/cli" which was deleted but still referenced)
let removeCount = 0;
const danglingIssues = [];

for (const dir of workspaceDirs) {
  const pkgPath = join(dir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    continue;
  }

  const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
  const rel = relative(ROOT, pkgPath);
  let changed = false;

  for (const section of DEP_SECTIONS) {
    if (!pkg[section]) continue;
    for (const [depName, depVersion] of Object.entries(pkg[section])) {
      if (depVersion === "workspace:*" && !nameToDir.has(depName)) {
        if (CHECK_MODE) {
          danglingIssues.push(
            `${rel}  ${section}.${depName}: "workspace:*" references nonexistent package`,
          );
        } else {
          if (!QUIET) {
            console.log(
              `  rm   ${rel}  ${section}.${depName}: "workspace:*" (package not in workspace)`,
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
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
  }
}

// 4. Summary
console.log("");
const totalIssues = fixCount + removeCount;

if (CHECK_MODE) {
  if (totalIssues > 0) {
    console.log(`FAIL: ${totalIssues} issue(s) found:\n`);
    for (const issue of [...issues, ...danglingIssues]) {
      console.log(`  ${issue}`);
    }
    console.log(`\nRun \`node scripts/fix-workspace-deps.mjs\` to fix them.`);
    process.exit(1);
  } else {
    console.log(
      `OK: all ${nameToDir.size} workspace packages use correct references.`,
    );
  }
} else {
  const parts = [];
  if (fixCount > 0) parts.push(`${fixCount} version(s) → workspace:*`);
  if (removeCount > 0) parts.push(`${removeCount} dangling ref(s) removed`);
  if (parts.length > 0) {
    console.log(`Done: ${parts.join(", ")}.`);
  } else {
    console.log(
      `All workspace references are already correct. Nothing to fix.`,
    );
  }
}
