#!/usr/bin/env node
/**
 * patch-llama-cpp-capacitor.mjs
 *
 * Bun v1.3.x has been observed to mis-apply patches that touch deeply-nested
 * directories inside cached packages (related bugs:
 *  - https://github.com/oven-sh/bun/issues/13330
 *  - https://github.com/oven-sh/bun/issues/13770).
 *
 * This script applies patches/llama-cpp-capacitor@0.1.5.patch using the
 * system `patch` utility instead, targeting all installed
 * llama-cpp-capacitor copies in node_modules/.bun.
 *
 * The patch rewrites android/build.gradle (per-ABI DFlash lib dirs, riscv64
 * added to abiFilters), android/src/main/CMakeLists.txt (drop vendored
 * llama.cpp sources, link against DFlash .so via the Eliza JNI bridge) and
 * android/src/main/java/.../LlamaCpp.java (riscv64 library mapping and
 * DFlash dependency preload). It is idempotent: `patch --forward` exits 1
 * when already applied, which is treated as success.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeModulesDir = join(repoRoot, "node_modules");
const bunCacheDir = join(nodeModulesDir, ".bun");
const patchFile = join(repoRoot, "patches", "llama-cpp-capacitor@0.1.5.patch");

if (!existsSync(nodeModulesDir)) {
  process.exit(0);
}

if (!existsSync(patchFile)) {
  console.warn("[patch-llama-cpp-capacitor] Patch file not found — skipping.");
  process.exit(0);
}

// Check that `patch` is available on PATH.
const patchCheck = spawnSync("patch", ["--version"], { encoding: "utf8" });
if (patchCheck.status !== 0 && patchCheck.error) {
  console.warn(
    "[patch-llama-cpp-capacitor] `patch` utility not found — skipping.",
  );
  process.exit(0);
}

// Discover every installed llama-cpp-capacitor copy: the top-level
// node_modules entry (used at build time by the Android app) and every
// per-hash bun cache copy. Bun's installer does not always hardlink the
// top-level copy back to the cache, so we must patch both.
const candidates = [];
const topLevel = join(nodeModulesDir, "llama-cpp-capacitor");
if (existsSync(topLevel)) {
  candidates.push({ label: "node_modules/llama-cpp-capacitor", dir: topLevel });
}
if (existsSync(bunCacheDir)) {
  for (const entry of readdirSync(bunCacheDir)) {
    if (!entry.startsWith("llama-cpp-capacitor@0.1.5")) continue;
    const pkgDir = join(
      bunCacheDir,
      entry,
      "node_modules",
      "llama-cpp-capacitor",
    );
    if (existsSync(pkgDir)) {
      candidates.push({ label: `node_modules/.bun/${entry}`, dir: pkgDir });
    }
  }
}

let patched = 0;
let skipped = 0;
let failed = 0;

for (const { label, dir: pkgDir } of candidates) {
  // Idempotency check — the patch always changes abiFilters from
  // `'arm64-v8a'` to `'arm64-v8a', 'riscv64'`. We probe build.gradle to
  // decide whether to re-run `patch`.
  const buildGradle = join(pkgDir, "android", "build.gradle");
  if (existsSync(buildGradle)) {
    try {
      const contents = readFileSync(buildGradle, "utf8");
      if (contents.includes("'arm64-v8a', 'riscv64'")) {
        skipped++;
        continue;
      }
    } catch {
      // fall through to patch invocation; --forward is still idempotent
    }
  }

  // Apply with --forward to skip already-applied hunks, --batch to never
  // prompt interactively. Exit 0 = all hunks applied, exit 1 = some hunks
  // already applied (acceptable), exit 2+ = real error.
  const result = spawnSync(
    "patch",
    ["-p1", "--batch", "--forward", `-i`, patchFile],
    { cwd: pkgDir, encoding: "utf8" },
  );

  if (result.status === 0 || result.status === 1) {
    patched++;
  } else {
    failed++;
    console.error(
      `[patch-llama-cpp-capacitor] Failed to patch ${label}:\n${result.stderr}`,
    );
  }
}

if (patched > 0 || skipped > 0 || failed > 0) {
  console.log(
    `[patch-llama-cpp-capacitor] patched=${patched} already-applied=${skipped} failed=${failed}`,
  );
}
