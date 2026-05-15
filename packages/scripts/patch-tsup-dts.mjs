#!/usr/bin/env node
/**
 * patch-tsup-dts.mjs
 *
 * tsup 8.5.1's rollup-plugin-dts integration has two workspace-specific
 * problems:
 *
 * 1. It hard-codes `baseUrl: "."` when no explicit baseUrl is set. TypeScript
 *    6.0 deprecated `baseUrl` and emits TS5101 for it when injected
 *    unconditionally.
 * 2. Some installs are patched to use `@rollup/wasm-node`, but the patch can
 *    leave malformed code behind when the cached package was already partially
 *    patched. Repair that shape deterministically so DTS workers remain valid
 *    CommonJS.
 *
 * The workspace-root tsup is already patched. This script finds every
 * bun-cached tsup@8.5.1 that still has the unpatched line and removes the
 * `baseUrl` injection so DTS builds do not trigger TS5101.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");

if (!existsSync(bunCacheDir)) {
  process.exit(0);
}

const BASE_URL_NEEDLE = 'baseUrl: compilerOptions.baseUrl || ".",';
const BASE_URL_REPLACEMENT =
  "// Patched: do not inject `baseUrl` (deprecated in TS 6.0). Preserve any\n" +
  "            // explicit user-set baseUrl from `compilerOptions` via the spread above.";
const ROLLUP_REQUIRE = /require\("rollup"\)/g;
const WASM_NODE_REQUIRE = 'require("@rollup/wasm-node")';
const ROLLUP_IMPORT_LINE = `  const { rollup } = await Promise.resolve().then(() => _interopRequireWildcard(${WASM_NODE_REQUIRE}));`;
const WATCH_IMPORT_LINE = `  const { watch } = await Promise.resolve().then(() => _interopRequireWildcard(${WASM_NODE_REQUIRE}));`;
const STRAY_ROLLUP_LINE =
  /\n\s*const getDuration = \(\) => \{\n\s*const \{ rollup \} = await Promise\.resolve\(\)\.then\(\(\) => _interopRequireWildcard\(require\("@rollup\/wasm-node"\)\)\);\n\s*\};/;
const STRAY_WATCH_LINE =
  /\n\s*plugins: options\.inputConfig\.plugins,\n\s*const \{ watch \} = await Promise\.resolve\(\)\.then\(\(\) => _interopRequireWildcard\(require\("@rollup\/wasm-node"\)\)\);/;

let patched = 0;

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
  if (!existsSync(rollupPath)) continue;
  const src = readFileSync(rollupPath, "utf8");
  let next = src;

  if (next.includes(BASE_URL_NEEDLE)) {
    next = next.replace(BASE_URL_NEEDLE, BASE_URL_REPLACEMENT);
  }

  next = next.replace(ROLLUP_REQUIRE, WASM_NODE_REQUIRE);
  next = next.replace(
    STRAY_ROLLUP_LINE,
    "\n    const getDuration = () => `${Date.now() - start}ms`;",
  );
  next = next.replace(
    /\n\s*const getDuration = \(\) => \{\n\s*\};/,
    "\n    const getDuration = () => `${Date.now() - start}ms`;",
  );
  next = next.replace(
    STRAY_WATCH_LINE,
    "\n    plugins: options.inputConfig.plugins,",
  );
  next = next.replace(
    /async function runRollup\(options\) \{\n(?!\s*const \{ rollup \})/,
    `async function runRollup(options) {\n${ROLLUP_IMPORT_LINE}\n`,
  );
  next = next.replace(
    /async function watchRollup\(options\) \{\n(?!\s*const \{ watch \})/,
    `async function watchRollup(options) {\n${WATCH_IMPORT_LINE}\n`,
  );

  if (next === src) continue;
  writeFileSync(rollupPath, next, "utf8");
  console.log(`[patch-tsup-dts] Patched ${rollupPath}`);
  patched++;
}

if (patched === 0) {
  console.log("[patch-tsup-dts] No unpatched tsup@8.5.1 DTS builds found.");
}
