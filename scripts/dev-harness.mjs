#!/usr/bin/env node
/**
 * Agent harness dev (TUI / watch): plugin submodules, install, build plugin dist if missing,
 * then `packages/agent` in watch mode.
 *
 * Run via: `bun run dev:harness` from the eliza repo root.
 * For the web + API dev stack, use `bun run dev` instead.
 *
 * For registry-only plugins (no submodules), use `bun run plugin-submodules:restore` and commit.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALL_STAMP = join(ROOT, ".eliza", "plugin-dev-needs-install");

const PLUGIN_TYPESCRIPT = [
  "plugins/plugin-sql",
  "plugins/plugin-ollama",
  "plugins/plugin-local-ai",
];

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

console.log("[dev] plugin submodules + workspace deps…\n");
run("bun", ["scripts/plugin-submodules-dev.mjs"]);

const nodeModules = join(ROOT, "node_modules");
const needsInstall = !existsSync(nodeModules) || existsSync(INSTALL_STAMP);
if (needsInstall) {
  console.log("\n[dev] bun install…\n");
  run("bun", ["install"]);
  if (existsSync(INSTALL_STAMP)) {
    try {
      unlinkSync(INSTALL_STAMP);
    } catch {
      /* ignore */
    }
  }
} else {
  console.log("\n[dev] bun install skipped (deps unchanged)\n");
}

// The @elizaos/core dist barrel (`dist/index.node.js`) re-exports from
// `dist/node/index.node.js`, which is only produced by the full build. A stale
// declarations-only dist leaves the barrel present but the node/ subdir
// missing, so check for the real runtime entry, not just the dist/ folder.
const coreNodeEntry = join(
  ROOT,
  "packages",
  "typescript",
  "dist",
  "node",
  "index.node.js",
);
if (!existsSync(coreNodeEntry)) {
  console.log("\n[dev] building `@elizaos/core` (no dist/node/)…\n");
  run("bun", ["run", "build:core"]);
}

for (const rel of PLUGIN_TYPESCRIPT) {
  const dir = join(ROOT, rel);
  if (!existsSync(join(dir, "package.json"))) {
    continue;
  }
  if (!existsSync(join(dir, "dist"))) {
    console.log(`\n[dev] building ${rel} (no dist/)…\n`);
    run("bun", ["run", "build"], { cwd: dir });
  }
}

console.log("\n[dev] agent harness (watch)…\n");
run("bun", ["run", "--cwd", "packages/agent", "dev"]);
