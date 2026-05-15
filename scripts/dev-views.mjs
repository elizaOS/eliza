#!/usr/bin/env node
/**
 * Watch-mode builder for plugin view bundles.
 *
 * Scans `plugins/` for per-plugin `vite.config.views.ts` files and starts
 * `vite build --watch` for each one in parallel. Output is prefixed with the
 * plugin name so simultaneous rebuilds are easy to read.
 *
 * Usage:
 *   node scripts/dev-views.mjs                       # watch all view plugins
 *   node scripts/dev-views.mjs --filter wallet       # only plugins whose name contains "wallet"
 *
 * Run this in a separate terminal alongside `bun run dev` when developing
 * plugin views. Changes to a plugin's source files will trigger an automatic
 * rebuild; the frontend auto-refreshes via ETag-based polling (2s interval).
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");

const VIEW_CONFIG_NAME = "vite.config.views.ts";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterIndex = args.findIndex((a) => a === "--filter");
const filterValue = filterIndex !== -1 ? args[filterIndex + 1] : undefined;

// ─── Discover plugins ─────────────────────────────────────────────────────────

function findPluginDirs() {
  try {
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(pluginsRoot, e.name));
  } catch {
    return [];
  }
}

const allPluginDirs = findPluginDirs().filter((d) =>
  existsSync(path.join(d, VIEW_CONFIG_NAME)),
);

const pluginDirs = filterValue
  ? allPluginDirs.filter((d) =>
      path.basename(d).toLowerCase().includes(filterValue.toLowerCase()),
    )
  : allPluginDirs;

if (pluginDirs.length === 0) {
  console.log(
    `[dev-views] No plugins with ${VIEW_CONFIG_NAME} found` +
      (filterValue ? ` matching filter "${filterValue}"` : "") +
      " — nothing to watch.",
  );
  process.exit(0);
}

console.log(
  `[dev-views] Starting watch for ${pluginDirs.length} plugin(s):`,
);
for (const d of pluginDirs) {
  console.log(`  ${path.relative(repoRoot, d)}`);
}
console.log("");

// ─── Start watchers ───────────────────────────────────────────────────────────

/** @type {import("node:child_process").ChildProcess[]} */
const procs = [];

for (const pluginDir of pluginDirs) {
  const tag = path.basename(pluginDir);
  const configPath = path.join(pluginDir, VIEW_CONFIG_NAME);

  const proc = spawn(
    "bunx",
    ["vite", "build", "--watch", "--config", configPath],
    {
      cwd: pluginDir,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "development" },
    },
  );

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) console.log(`[${tag}] ${trimmed}`);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) console.error(`[${tag}] ${trimmed}`);
    }
  });

  proc.on("close", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${tag}] exited with code ${code}`);
    }
  });

  procs.push(proc);
}

// ─── Clean up on exit ─────────────────────────────────────────────────────────

function shutdown() {
  for (const proc of procs) {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
