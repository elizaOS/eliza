#!/usr/bin/env node

/**
 * plugin-submodules-dev.mjs
 *
 * Selected plugins under plugins/* are vendored in-tree; this script only
 * adjusts workspaces and self-deps for local development (sql, ollama, local-ai).
 *
 *   DEV (default — no flag, or `--dev`):
 *     1. `git submodule update --init` for each configured path (no-op when trees exist)
 *     2. Append `plugins/...` entries to root package.json workspaces
 *     3. Remove self-dependencies on the package name (e.g. @elizaos/plugin-sql → itself)
 *        so bun does not hit a workspace dependency loop
 *     4. Run `scripts/fix-workspace-deps.mjs` when `--check` fails (otherwise skip)
 *
 * Idempotent: safe to run repeatedly; skips submodule update, workspace/self-dep edits, and fix-deps when already satisfied.
 * Writes `.eliza/plugin-dev-needs-install` when anything changed so `scripts/dev-harness.mjs` can run `bun install` only then.
 *
 *   RESTORE (--restore):
 *     1. Run `scripts/fix-workspace-deps.mjs --restore` (parent-repo package.json only)
 *     2. Remove the plugin workspace entries from root package.json
 *     3. `git checkout -- package.json` inside each submodule (reset submodule trees)
 *
 * Pair with:
 *   - `bun run fix-deps` for the rest of the monorepo
 *   - `scripts/replace-workspace-versions.js` for publish (Lerna)
 *
 * Usage:
 *   bun run dev:harness            # runs this, then agent watch
 *   node scripts/plugin-submodules-dev.mjs
 *   node scripts/plugin-submodules-dev.mjs --restore
 *   node scripts/plugin-submodules-dev.mjs --quiet
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEV = !process.argv.includes("--restore");
const QUIET = process.argv.includes("--quiet");

/** Written when package.json / workspace state changed; dev-harness runs `bun install` then deletes it. */
const INSTALL_STAMP = join(ROOT, ".eliza", "plugin-dev-needs-install");

function touchInstallStamp() {
  mkdirSync(join(ROOT, ".eliza"), { recursive: true });
  writeFileSync(INSTALL_STAMP, `${Date.now()}\n`);
}

/** Submodules under plugins/ and their Bun workspace path (package root). */
const PLUGIN_SUBMODULES = [
  {
    submodulePath: "plugins/plugin-sql",
    workspaceEntry: "plugins/plugin-sql",
    packageName: "@elizaos/plugin-sql",
  },
  {
    submodulePath: "plugins/plugin-ollama",
    workspaceEntry: "plugins/plugin-ollama",
    packageName: "@elizaos/plugin-ollama",
  },
  {
    submodulePath: "plugins/plugin-local-ai",
    workspaceEntry: "plugins/plugin-local-ai",
    packageName: "@elizaos/plugin-local-ai",
  },
];

/** Registry dist-tag when these packages are not linked from submodules. */
const PLUGIN_REGISTRY_TAG = "beta";

const ROOT_AND_AGENT_PKG = [
  join(ROOT, "package.json"),
  join(ROOT, "agent", "package.json"),
];

const FIX_DEPS_SCRIPT = join(ROOT, "scripts", "fix-workspace-deps.mjs");

function log(...args) {
  if (!QUIET) console.log(...args);
}

function readRootPackage() {
  const p = join(ROOT, "package.json");
  const raw = readFileSync(p, "utf8");
  return { path: p, raw, pkg: JSON.parse(raw) };
  // Note: reads file once, storing raw data for both returning and parsing efficiency
}

function writePackageJson(path, raw, pkg) {
  const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
  writeFileSync(path, `${JSON.stringify(pkg, null, indent)}\n`);
}

function ensureWorkspaces() {
  const { path, raw, pkg } = readRootPackage();
  const ws = pkg.workspaces;
  if (!Array.isArray(ws)) {
    throw new Error("package.json: missing workspaces array");
  }
  let changed = false;
  for (const { workspaceEntry } of PLUGIN_SUBMODULES) {
    if (!ws.includes(workspaceEntry)) {
      ws.push(workspaceEntry);
      log(`  workspaces  + ${workspaceEntry}`);
      changed = true;
    }
  }
  if (changed) {
    writePackageJson(path, raw, pkg);
  }
  return changed;
}

function pluginPackagesPresent() {
  return PLUGIN_SUBMODULES.every(({ workspaceEntry }) =>
    existsSync(join(ROOT, workspaceEntry, "package.json")),
  );
}

function stripWorkspaces() {
  const { path, raw, pkg } = readRootPackage();
  const ws = pkg.workspaces;
  if (!Array.isArray(ws)) return false;
  const remove = new Set(PLUGIN_SUBMODULES.map((p) => p.workspaceEntry));
  const next = ws.filter((e) => !remove.has(e));
  if (next.length === ws.length) return false;
  for (const e of ws) {
    if (remove.has(e)) log(`  workspaces  − ${e}`);
  }
  pkg.workspaces = next;
  writePackageJson(path, raw, pkg);
  return true;
}

function removeSelfDependencies() {
  const sections = ["dependencies", "devDependencies", "peerDependencies"];
  let any = false;
  for (const { workspaceEntry } of PLUGIN_SUBMODULES) {
    const pkgPath = join(ROOT, workspaceEntry, "package.json");
    if (!existsSync(pkgPath)) {
      log(`  skip  (no file) ${relative(ROOT, pkgPath)}`);
      continue;
    }
    const raw = readFileSync(pkgPath, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    const name = pkg.name;
    if (!name) continue;
    const _indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
    let changed = false;
    for (const sec of sections) {
      if (!pkg[sec]?.[name]) continue;
      delete pkg[sec][name];
      log(`  self-dep  rm  ${relative(ROOT, pkgPath)}  ${sec}.${name}`);
      changed = true;
    }
    if (changed) {
      writePackageJson(pkgPath, raw, pkg);
      any = true;
    }
  }
  return any;
}

/** @returns {boolean} true if `git submodule update` ran successfully (new checkouts may need `bun install`). */
function submoduleInit() {
  if (pluginPackagesPresent()) {
    log("  submodules  already present (skip git submodule update)");
    return false;
  }
  const paths = PLUGIN_SUBMODULES.map((p) => p.submodulePath);
  try {
    execFileSync(
      "git",
      ["submodule", "update", "--init", "--recursive", ...paths],
      { cwd: ROOT, stdio: QUIET ? "pipe" : "inherit" },
    );
    return true;
  } catch {
    log("  warning: git submodule update failed (network or .gitmodules).");
    return false;
  }
}

/**
 * After fix-workspace-deps --restore, deps that did not exist at HEAD stay workspace:*.
 * Force registry tag for known submodule plugin names on root + agent only.
 */
function pinPluginDepsToRegistry() {
  const names = new Set(PLUGIN_SUBMODULES.map((plugin) => plugin.packageName));
  for (const path of ROOT_AND_AGENT_PKG) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    let changed = false;
    if (!pkg.dependencies) continue;
    for (const name of names) {
      if (pkg.dependencies[name] === "workspace:*") {
        pkg.dependencies[name] = PLUGIN_REGISTRY_TAG;
        log(
          `  registry  ${relative(ROOT, path)}  dependencies.${name} -> "${PLUGIN_REGISTRY_TAG}"`,
        );
        changed = true;
      }
    }
    if (changed) {
      writePackageJson(path, raw, pkg);
    }
  }
}

function resetSubmodulePackageJson() {
  for (const { submodulePath } of PLUGIN_SUBMODULES) {
    const abs = join(ROOT, submodulePath);
    if (!existsSync(join(abs, ".git"))) {
      // not checked out or not a submodule worktree
      continue;
    }
    try {
      execFileSync("git", ["checkout", "--", "package.json"], {
        cwd: abs,
        stdio: QUIET ? "pipe" : "inherit",
      });
      log(`  reset  ${submodulePath}/package.json`);
    } catch {
      log(
        `  skip reset  ${submodulePath} (no typescript/package.json in index?)`,
      );
    }
  }
}

function runFixWorkspaceDeps(args = []) {
  const extra = QUIET && !args.includes("--quiet") ? ["--quiet"] : [];
  execFileSync(process.execPath, [FIX_DEPS_SCRIPT, ...args, ...extra], {
    cwd: ROOT,
    stdio: QUIET ? "pipe" : "inherit",
  });
}

/** True if fix-workspace-deps --check passes (no rewrites needed). */
function fixWorkspaceDepsCheckPasses() {
  const extra = QUIET ? ["--quiet"] : [];
  try {
    execFileSync(process.execPath, [FIX_DEPS_SCRIPT, "--check", ...extra], {
      cwd: ROOT,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

if (DEV) {
  log("plugin-submodules-dev: dev (link submodules for local editing)\n");
  let mutated = submoduleInit();
  if (!pluginPackagesPresent()) {
    throw new Error(
      "Plugin submodules are unavailable; aborting workspace/dependency rewrites.",
    );
  }
  mutated = ensureWorkspaces() || mutated;
  mutated = removeSelfDependencies() || mutated;

  if (fixWorkspaceDepsCheckPasses()) {
    log("\nfix-workspace-deps: already satisfied (skip)\n");
  } else {
    log("\nRunning fix-workspace-deps.mjs …\n");
    runFixWorkspaceDeps();
    mutated = true;
  }

  if (mutated) {
    touchInstallStamp();
  } else {
    log(
      "No package.json / workspace changes — already linked for local dev.\n",
    );
  }
  process.exit(0);
}

// RESTORE
log("plugin-submodules-dev: RESTORE\n");
log("Running fix-workspace-deps.mjs --restore …\n");
runFixWorkspaceDeps(["--restore"]);
pinPluginDepsToRegistry();
stripWorkspaces();
log("\nResetting submodule typescript/package.json files …\n");
resetSubmodulePackageJson();
touchInstallStamp();
log(`
Next:
  bun install
`);
process.exit(0);
