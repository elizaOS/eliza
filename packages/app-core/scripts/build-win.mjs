#!/usr/bin/env node
/**
 * Windows-compatible build script for Eliza.
 * Replaces the Unix-only "build" npm script.
 *
 * Steps:
 *   1. tsdown (backend bundle)
 *   2. Write build info + dist/package.json (write-build-info.ts)
 *   3. Build all Capacitor plugins
 *   4. vite build the app (renderer)
 *
 * Usage:
 *   node scripts/build-win.mjs [--skip-plugins] [--skip-install]
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  CAPACITOR_PLUGIN_NAMES,
  NATIVE_PLUGINS_ROOT,
} from "../../app/scripts/capacitor-plugin-names.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const appDir = join(rootDir, "apps", "app");

// Parse args
const args = process.argv.slice(2);
let skipPlugins = false;
let skipInstall = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--skip-plugins") {
    skipPlugins = true;
  } else if (args[i] === "--skip-install") {
    skipInstall = true;
  }
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", shell: true, ...opts });
}

try {
  // Step 1: tsdown build
  console.log("\n=== Step 1/4: tsdown (backend bundle) ===");
  run("npx tsdown", { cwd: rootDir });

  // Step 2: write-build-info (also writes dist/package.json)
  console.log("\n=== Step 2/4: Write build info ===");
  run("node --import tsx scripts/write-build-info.ts", { cwd: rootDir });

  // Step 3: Build plugins
  if (!skipPlugins) {
    console.log("\n=== Step 3/4: Build Capacitor plugins ===");
    const plugins = CAPACITOR_PLUGIN_NAMES;
    for (const plugin of plugins) {
      const pluginDir = join(NATIVE_PLUGINS_ROOT, plugin);
      if (!existsSync(pluginDir)) {
        console.log(`  [plugin:${plugin}] directory not found, skipping`);
        continue;
      }
      console.log(`  [plugin:${plugin}] building...`);
      run("bun run build", { cwd: pluginDir });
    }
  } else {
    console.log("\n=== Step 3/4: Skipping plugins (--skip-plugins) ===");
  }

  // Step 4: vite build
  console.log("\n=== Step 4/4: vite build ===");
  if (!skipInstall) {
    run("bun install --ignore-scripts", { cwd: appDir });
  }
  run(`bun run build:web`, { cwd: appDir });

  console.log("\n=== Build complete! ===");
} catch (e) {
  console.error("\nBuild failed:", e.message);
  process.exit(1);
}
