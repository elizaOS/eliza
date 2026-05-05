#!/usr/bin/env node
/**
 * patch-tsup-dts.mjs
 *
 * tsup 8.5.1's rollup-plugin-dts integration hard-codes `baseUrl: "."` when
 * no explicit baseUrl is set. TypeScript 6.0 deprecated `baseUrl` and emits
 * TS5101 for it when injected unconditionally.
 *
 * The workspace-root tsup is already patched. This script finds every
 * bun-cached tsup@8.5.1 that still has the unpatched line and removes the
 * `baseUrl` injection so DTS builds do not trigger TS5101.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");

if (!existsSync(bunCacheDir)) {
  process.exit(0);
}

const NEEDLE = 'baseUrl: compilerOptions.baseUrl || ".",';
const REPLACEMENT =
  "// Patched: do not inject `baseUrl` (deprecated in TS 6.0). Preserve any\n" +
  "            // explicit user-set baseUrl from `compilerOptions` via the spread above.";

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
  if (!src.includes(NEEDLE)) continue;
  writeFileSync(rollupPath, src.replace(NEEDLE, REPLACEMENT), "utf8");
  console.log(`[patch-tsup-dts] Patched ${rollupPath}`);
  patched++;
}

if (patched === 0) {
  console.log("[patch-tsup-dts] No unpatched tsup@8.5.1 DTS builds found.");
}
