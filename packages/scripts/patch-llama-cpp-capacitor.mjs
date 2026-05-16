#!/usr/bin/env node
/**
 * patch-llama-cpp-capacitor.mjs
 *
 * Bun v1.3.x cannot apply patches that CREATE new files in deeply-nested
 * directories (bug: https://github.com/oven-sh/bun/issues/13330).
 * patches/llama-cpp-capacitor@0.1.5.patch creates
 * android/src/main/eliza-dflash-jni.cpp (3 levels deep), which triggers this
 * bug with EACCES: Permission denied (mkdir()).
 *
 * This script applies the patch using the system `patch` utility instead,
 * targeting all installed llama-cpp-capacitor copies in node_modules/.bun.
 * It is idempotent: if the patch is already applied it skips cleanly.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");
const patchFile = join(repoRoot, "patches", "llama-cpp-capacitor@0.1.5.patch");

if (!existsSync(bunCacheDir)) {
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

let patched = 0;
let skipped = 0;

for (const entry of readdirSync(bunCacheDir)) {
  if (!entry.startsWith("llama-cpp-capacitor@0.1.5")) continue;

  const pkgDir = join(
    bunCacheDir,
    entry,
    "node_modules",
    "llama-cpp-capacitor",
  );

  if (!existsSync(pkgDir)) continue;

  // Idempotency check — the patch adds this file.
  const sentinelFile = join(
    pkgDir,
    "android",
    "src",
    "main",
    "eliza-dflash-jni.cpp",
  );
  if (existsSync(sentinelFile)) {
    skipped++;
    continue;
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
    console.error(
      `[patch-llama-cpp-capacitor] Failed to patch ${entry}:\n${result.stderr}`,
    );
  }
}

if (patched > 0 || skipped > 0) {
  console.log(
    `[patch-llama-cpp-capacitor] patched=${patched} already-applied=${skipped}`,
  );
}
