#!/usr/bin/env node
/**
 * patch-tsup-dts.mjs
 *
 * tsup 8.5.1's rollup-plugin-dts integration hard-codes `baseUrl: "."` when
 * no explicit baseUrl is set. TypeScript 6.0 deprecated `baseUrl` and emits
 * TS5101 when it is injected unconditionally.
 *
 * Bun may install multiple physical copies of tsup (workspace-root patch,
 * `.bun` cache trees, and per-package `node_modules/tsup`). Patch every copy's
 * `dist/rollup.js` so DTS builds stay compatible with TypeScript 6+ without
 * `ignoreDeprecations`.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const NEEDLE = 'baseUrl: compilerOptions.baseUrl || ".",';
const REPLACEMENT =
  "// Patched: do not inject `baseUrl` (deprecated in TS 6.0). Preserve any\n" +
  "            // explicit user-set baseUrl from `compilerOptions` via the spread above.";

/** @param {string} rollupPath */
function patchFile(rollupPath) {
  const src = readFileSync(rollupPath, "utf8");
  if (!src.includes(NEEDLE)) return false;
  writeFileSync(rollupPath, src.replace(NEEDLE, REPLACEMENT), "utf8");
  return true;
}

/** Bun nests versioned installs under `node_modules/.bun/tsup@8.5.1+…`. */
function collectBunCacheRollups() {
  const bunRoots = [
    join(repoRoot, "node_modules", ".bun"),
    join(repoRoot, "cloud", "node_modules", ".bun"),
  ];
  const out = [];
  for (const bunCacheDir of bunRoots) {
    if (!existsSync(bunCacheDir)) continue;
    for (const entry of readdirSync(bunCacheDir)) {
      if (!entry.startsWith("tsup@8.5.1")) continue;
      const rollupPath = join(
        bunCacheDir,
        entry,
        "node_modules",
        "tsup",
        "dist",
        "rollup.js",
      );
      if (existsSync(rollupPath)) out.push(rollupPath);
    }
  }
  return out;
}

function pushIfRollupExists(out, rollupPath) {
  if (existsSync(rollupPath)) out.push(rollupPath);
}

/**
 * Direct `node_modules/tsup` installs next to workspace packages (no `.bun`).
 */
function collectNestedWorkspaceRollups() {
  const out = [];

  const pluginsDir = join(repoRoot, "plugins");
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      pushIfRollupExists(
        out,
        join(pluginsDir, name, "node_modules", "tsup", "dist", "rollup.js"),
      );
    }
  }

  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      pushIfRollupExists(
        out,
        join(packagesDir, name, "node_modules", "tsup", "dist", "rollup.js"),
      );
      if (name !== "examples") continue;
      const examplesRoot = join(packagesDir, "examples");
      for (const ex of readdirSync(examplesRoot)) {
        pushIfRollupExists(
          out,
          join(
            examplesRoot,
            ex,
            "node_modules",
            "tsup",
            "dist",
            "rollup.js",
          ),
        );
      }
    }
  }

  const cloudRoot = join(repoRoot, "cloud");
  if (existsSync(cloudRoot)) {
    for (const sub of ["apps", "packages", "services"]) {
      const sd = join(cloudRoot, sub);
      if (!existsSync(sd)) continue;
      for (const name of readdirSync(sd)) {
        pushIfRollupExists(
          out,
          join(sd, name, "node_modules", "tsup", "dist", "rollup.js"),
        );
      }
    }
  }

  return out;
}

function collectRootRollup() {
  const rollupPath = join(
    repoRoot,
    "node_modules",
    "tsup",
    "dist",
    "rollup.js",
  );
  return existsSync(rollupPath) ? [rollupPath] : [];
}

const targets = [
  ...collectRootRollup(),
  ...collectBunCacheRollups(),
  ...collectNestedWorkspaceRollups(),
];

const seen = new Set();
let patched = 0;

for (const rollupPath of targets) {
  if (seen.has(rollupPath)) continue;
  seen.add(rollupPath);
  if (patchFile(rollupPath)) {
    console.log(`[patch-tsup-dts] Patched ${rollupPath}`);
    patched++;
  }
}

if (patched === 0) {
  console.log("[patch-tsup-dts] No unpatched tsup@8.5.1 DTS builds found.");
}
