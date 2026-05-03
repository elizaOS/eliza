#!/usr/bin/env node
/**
 * One-shot local workspace setup for a monorepo that consumes repo-local
 * eliza + plugin checkouts alongside npm-published peers.
 *
 *   1. git submodule sync + update (recursive, init all)
 *   2. snapshot every workspace package.json on disk
 *   3. rewrite in-repo dependency specifiers to "workspace:*" (fix-workspace-deps)
 *   4. bun install (refresh lockfile + postinstall)
 *   5. restore package.json files from the snapshot — so "workspace:*" does
 *      NOT persist on disk and plugin submodules stay clean in `git status`
 *
 * Why snapshot+restore instead of commit-it-forever:
 *   Plugin submodules (eliza/plugins/plugin-*) are PUBLISHED TO NPM from their
 *   own repos. Their committed package.json uses "@elizaos/core": "alpha"
 *   so npm consumers can install them. If we left "workspace:*" on disk
 *   after install, users would see dirty submodules and (worse) could
 *   accidentally commit it back to the plugin repos, breaking npm install.
 *
 *   Bun's root-package.json `overrides` field handles the runtime redirect
 *   to workspace packages regardless of what specifier the plugin declares,
 *   so the on-disk rewrite is only needed for the duration of `bun install`.
 *
 * Usage:
 *   bun scripts/workspace-prepare.mjs
 *   bun scripts/workspace-prepare.mjs --remote         # submodule update --remote
 *   bun scripts/workspace-prepare.mjs --skip-fix-deps  # no rewrite at all
 *   bun scripts/workspace-prepare.mjs --skip-install   # no bun install
 *   bun scripts/workspace-prepare.mjs --leave-on-disk  # opt out of restore (rare)
 *   bun scripts/workspace-prepare.mjs --help
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkspaceMaps } from "./lib/workspace-discovery.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE = process.argv.includes("--remote");
const SKIP_FIX = process.argv.includes("--skip-fix-deps");
const SKIP_INSTALL = process.argv.includes("--skip-install");
const LEAVE_ON_DISK = process.argv.includes("--leave-on-disk");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`workspace-prepare — submodule sync/update, fix-deps, bun install, restore

  bun scripts/workspace-prepare.mjs [options]

Options:
  --remote         Pass --remote to git submodule update (follow branch tips; changes SHAs)
  --skip-fix-deps  Skip the rewrite step entirely (equivalent to plain bun install)
  --skip-install   Submodules + fix-deps only (no bun install, no restore)
  --leave-on-disk  Leave "workspace:*" in package.json after install (legacy; rare)
  --help, -h       This message
`);
  process.exit(0);
}

function run(label, cmd, args) {
  console.log(`\n[workspace-prepare] ${label}\n  ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\n[workspace-prepare] failed: ${cmd} exited ${code}`);
    process.exit(code);
  }
}

// ── 1. submodules ─────────────────────────────────────────────────────

const gitDir = resolve(root, ".git");
if (existsSync(gitDir)) {
  run("submodule sync", "git", ["submodule", "sync", "--recursive"]);
  const updateArgs = ["submodule", "update", "--init", "--recursive"];
  if (REMOTE) {
    updateArgs.push("--remote");
  }
  run("submodule update", "git", updateArgs);
} else {
  console.log(
    "[workspace-prepare] No .git — skipping submodule sync/update (e.g. npm tarball checkout)",
  );
}

// ── 2. snapshot every workspace package.json ──────────────────────────
//
// We read-then-restore by raw bytes (not JSON round-trip) so the file is
// byte-identical after install: no whitespace drift, no key reordering.

/** @type {Map<string, string>} path -> original raw contents */
const snapshot = new Map();

if (!SKIP_FIX && !LEAVE_ON_DISK) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = rootPkg.workspaces || [];
  const { workspaceDirs } = collectWorkspaceMaps(root, patterns);
  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      snapshot.set(pkgPath, readFileSync(pkgPath, "utf8"));
    }
  }
  console.log(
    `\n[workspace-prepare] snapshotted ${snapshot.size} package.json file(s) for post-install restore\n`,
  );
}

function restoreSnapshot() {
  if (snapshot.size === 0) return;
  let restored = 0;
  for (const [pkgPath, original] of snapshot) {
    const current = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : null;
    if (current !== original) {
      writeFileSync(pkgPath, original, "utf8");
      restored++;
    }
  }
  console.log(
    `\n[workspace-prepare] restored ${restored} package.json file(s) to pre-install state\n`,
  );
}

// Best-effort restore on unexpected exit so a Ctrl+C mid-install doesn't
// leave the repo in a half-rewritten state.
if (snapshot.size > 0) {
  let restoredAlready = false;
  const cleanup = () => {
    if (restoredAlready) return;
    restoredAlready = true;
    try {
      restoreSnapshot();
    } catch (err) {
      console.error(
        "[workspace-prepare] snapshot restore failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
}

// ── 3. rewrite to workspace:* ────────────────────────────────────────

if (!SKIP_FIX) {
  run("fix in-repo deps → workspace:*", "bun", [
    resolve(root, "scripts/fix-workspace-deps.mjs"),
  ]);
} else {
  console.log(
    "\n[workspace-prepare] --skip-fix-deps: leaving dependency specifiers as-is\n",
  );
}

// ── 4. bun install ───────────────────────────────────────────────────

if (!SKIP_INSTALL) {
  run("install", "bun", ["install"]);
} else {
  console.log(
    "\n[workspace-prepare] --skip-install: not running bun install\n",
  );
}

// ── 5. restore package.json from snapshot ────────────────────────────

if (!SKIP_FIX && !LEAVE_ON_DISK && !SKIP_INSTALL) {
  restoreSnapshot();
} else if (LEAVE_ON_DISK) {
  console.log(
    "\n[workspace-prepare] --leave-on-disk: keeping workspace:* in package.json (legacy)\n",
  );
}

console.log("\n[workspace-prepare] done.\n");
