#!/usr/bin/env node
/**
 * One-shot local workspace setup:
 *   1. git submodule sync + update (init all submodules, recursive)
 *   2. Rewrite in-repo dependency specifiers to workspace:* (fix-workspace-deps)
 *   3. bun install (refresh lockfile + postinstall)
 *
 * Usage:
 *   bun scripts/workspace-prepare.mjs
 *   bun scripts/workspace-prepare.mjs --remote   # submodule update --remote (branch tips)
 *   bun scripts/workspace-prepare.mjs --skip-fix-deps
 *   bun scripts/workspace-prepare.mjs --skip-install
 *   bun scripts/workspace-prepare.mjs --help
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE = process.argv.includes("--remote");
const SKIP_FIX = process.argv.includes("--skip-fix-deps");
const SKIP_INSTALL = process.argv.includes("--skip-install");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`workspace-prepare — submodule sync/update, fix-deps, bun install

  bun scripts/workspace-prepare.mjs [options]

Options:
  --remote         Pass --remote to git submodule update (follow branch tips; changes SHAs)
  --skip-fix-deps  Only submodules + bun install (leave package.json specifiers unchanged)
  --skip-install   Submodules + fix-deps only (no bun install)
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

if (!SKIP_FIX) {
  run("fix in-repo deps → workspace:*", "bun", [
    resolve(root, "scripts/fix-workspace-deps.mjs"),
  ]);
} else {
  console.log(
    "\n[workspace-prepare] --skip-fix-deps: leaving dependency specifiers as-is\n",
  );
}

if (!SKIP_INSTALL) {
  run("install", "bun", ["install"]);
} else {
  console.log(
    "\n[workspace-prepare] --skip-install: not running bun install\n",
  );
}

console.log("\n[workspace-prepare] done.\n");
