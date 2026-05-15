#!/usr/bin/env node
/**
 * Build view bundles for all plugins that declare a `vite.config.views.ts`.
 *
 * Scans `plugins/` for per-plugin view bundle configs, then runs
 * `vite build --config vite.config.views.ts` in each plugin directory.
 *
 * Usage:
 *   bun run build:views              # build all view bundles
 *   bun run build:views -- --filter wallet  # only plugins whose name contains "wallet"
 *   node scripts/build-views.mjs --dry-run  # list but don't build
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");

const VIEW_CONFIG_NAME = "vite.config.views.ts";

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filterIndex = args.findIndex((a) => a === "--filter");
const filterValue =
  filterIndex !== -1 ? args[filterIndex + 1] : undefined;

// ─── Discover plugins with view configs ──────────────────────────────────────

/** @returns {string[]} absolute paths to plugin directories */
function findPluginDirs() {
  try {
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(pluginsRoot, e.name));
  } catch {
    return [];
  }
}

/** @param {string} pluginDir */
function hasViewConfig(pluginDir) {
  return existsSync(path.join(pluginDir, VIEW_CONFIG_NAME));
}

// ─── Build one plugin's views ────────────────────────────────────────────────

/**
 * @param {string} pluginDir
 * @returns {{ ok: boolean; output: string }}
 */
function buildPluginViews(pluginDir) {
  const configPath = path.join(pluginDir, VIEW_CONFIG_NAME);

  // Prefer bun; fall back to npx vite.
  const bunAvailable = (() => {
    const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  })();

  const [cmd, cmdArgs] = bunAvailable
    ? ["bun", ["x", "vite", "build", "--config", configPath]]
    : ["npx", ["vite", "build", "--config", configPath]];

  const result = spawnSync(cmd, cmdArgs, {
    cwd: pluginDir,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env },
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return { ok: result.status === 0, output };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const allPluginDirs = findPluginDirs().filter(hasViewConfig);

const pluginDirs = filterValue
  ? allPluginDirs.filter((d) =>
      path.basename(d).toLowerCase().includes(filterValue.toLowerCase()),
    )
  : allPluginDirs;

if (pluginDirs.length === 0) {
  console.log(
    `[build-views] No plugins with ${VIEW_CONFIG_NAME} found` +
      (filterValue ? ` matching filter "${filterValue}"` : "") +
      " — nothing to build.",
  );
  process.exit(0);
}

console.log(
  `[build-views] Found ${pluginDirs.length} plugin(s) with view configs:`,
);
for (const d of pluginDirs) {
  console.log(`  ${path.relative(repoRoot, d)}`);
}

if (dryRun) {
  console.log("[build-views] --dry-run: skipping build step.");
  process.exit(0);
}

let passed = 0;
let failed = 0;

for (const pluginDir of pluginDirs) {
  const relDir = path.relative(repoRoot, pluginDir);
  process.stdout.write(`\n[build-views] Building ${relDir} ... `);

  const { ok, output } = buildPluginViews(pluginDir);

  if (ok) {
    process.stdout.write("OK\n");
    passed++;
  } else {
    process.stdout.write("FAILED\n");
    if (output) {
      console.error(output);
    }
    failed++;
  }
}

console.log(
  `\n[build-views] Done — ${passed} succeeded, ${failed} failed.`,
);

if (failed > 0) {
  process.exit(1);
}
