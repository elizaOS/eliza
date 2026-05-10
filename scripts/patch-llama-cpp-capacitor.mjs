#!/usr/bin/env node
/**
 * Applies packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch inside each
 * installed llama-cpp-capacitor copy.
 *
 * Bun's patchedDependencies applies patches with the repository root as cwd,
 * so paths like ios/Frameworks-xcframework/... get mkdir'd at the repo root
 * (and with mode 0644 those dirs are not traversable). Running patch(1) from
 * the package directory avoids that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const patchFile = join(
  repoRoot,
  "packages",
  "app-core",
  "patches",
  "llama-cpp-capacitor@0.1.5.patch",
);

/** @returns {Generator<string>} */
function* llamaCppPackageRoots() {
  const bunDir = join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("llama-cpp-capacitor@")) continue;
      const pkg = join(bunDir, entry, "node_modules", "llama-cpp-capacitor");
      if (existsSync(join(pkg, "package.json"))) yield pkg;
    }
  }
  const hoisted = join(repoRoot, "node_modules", "llama-cpp-capacitor");
  if (existsSync(join(hoisted, "package.json"))) yield hoisted;
}

function alreadyPatched(pkgRoot) {
  const jni = join(pkgRoot, "android", "src", "main", "jni.cpp");
  if (!existsSync(jni)) return false;
  const text = readFileSync(jni, "utf8");
  return text.includes("optDoubleMethod");
}

function main() {
  if (!existsSync(patchFile)) {
    console.warn(
      "[patch-llama-cpp-capacitor] Patch file missing — skipping:",
      patchFile,
    );
    process.exit(0);
  }

  let applied = 0;
  for (const pkgRoot of llamaCppPackageRoots()) {
    if (alreadyPatched(pkgRoot)) continue;

    const r = spawnSync(
      "patch",
      ["--batch", "-p1", "-i", patchFile],
      { cwd: pkgRoot, encoding: "utf8" },
    );
    if (r.status !== 0) {
      console.error(r.stdout ?? "");
      console.error(r.stderr ?? "");
      process.exit(r.status ?? 1);
    }
    applied++;
    console.log(`[patch-llama-cpp-capacitor] Patched ${pkgRoot}`);
  }

  if (applied === 0) {
    console.log(
      "[patch-llama-cpp-capacitor] No installs to patch (or already patched).",
    );
  }
}

main();
