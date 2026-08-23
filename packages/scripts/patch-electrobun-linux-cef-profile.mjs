#!/usr/bin/env node

/**
 * Applies the pinned Electrobun 1.18.1 Linux x64 CEF profile hotfix.
 *
 * Chrome-runtime request-context profiles must be direct children of CEF's
 * root cache path. Electrobun 1.18.1 nests them under `partitions/`, causing
 * CEF to reject the profile and silently lose localStorage across relaunches.
 * The binary delta was built from the matching upstream v1.18.1 source with:
 *   - a non-empty global `<CEF>/Default` cache_path; and
 *   - SHA-256-named persistent profiles directly below `<CEF>`.
 *
 * Both input and output hashes are fail-closed so a dependency update cannot
 * accidentally receive a patch built for a different native wrapper.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requirePatch = process.argv.includes("--require");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const expectedVersion = "1.18.1";
const originalSha256 =
  "e7172d886925e4d728cf35cbee5a52ad17c33e9bb4c40248a788a0a10100df53";
const patchedSha256 =
  "1c0a3ef5472f9c6be37b2d983644016e13c07790533b369128f4d29643b8bcde";
const patchSha256 =
  "633253384fedb949d834de0cdb3db75f66e6e7306c9b25ba663cb28aa0a61956";
const patchPath = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "native",
  "linux",
  "electrobun-1.18.1-cef-profile-x64.bsdiff",
);

function fail(message) {
  console.error(`[patch-electrobun-linux-cef-profile] ${message}`);
  process.exit(1);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

if (process.platform !== "linux") {
  process.exit(0);
}

if (process.arch !== "x64") {
  const message = `No verified native CEF profile hotfix exists for Linux ${process.arch}.`;
  if (requirePatch) fail(message);
  console.warn(`[patch-electrobun-linux-cef-profile] ${message}`);
  process.exit(0);
}

if (!existsSync(patchPath) || sha256(patchPath) !== patchSha256) {
  fail(`Pinned binary delta is missing or corrupt: ${patchPath}`);
}

const manifestCandidates = [
  path.join(repoRoot, "node_modules", "electrobun", "package.json"),
  path.join(
    repoRoot,
    "packages",
    "app-core",
    "platforms",
    "electrobun",
    "node_modules",
    "electrobun",
    "package.json",
  ),
];
const packageRoots = new Set();
for (const manifestPath of manifestCandidates) {
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== expectedVersion) {
    fail(
      `Expected electrobun ${expectedVersion}, found ${String(manifest.version)} at ${manifestPath}.`,
    );
  }
  packageRoots.add(realpathSync(path.dirname(manifestPath)));
}

if (packageRoots.size === 0) {
  const message = "Electrobun is not installed; no native wrapper was patched.";
  if (requirePatch) fail(message);
  console.warn(`[patch-electrobun-linux-cef-profile] ${message}`);
  process.exit(0);
}

let patchedCount = 0;
for (const packageRoot of packageRoots) {
  const distDir = path.join(packageRoot, "dist-linux-x64");
  const targetPath = path.join(distDir, "libNativeWrapper_cef.so");
  const bspatchPath = path.join(distDir, "bspatch");
  if (!existsSync(targetPath) || !existsSync(bspatchPath)) {
    fail(`Electrobun Linux x64 native artifacts are incomplete at ${distDir}.`);
  }

  const beforeHash = sha256(targetPath);
  if (beforeHash === patchedSha256) continue;
  if (beforeHash !== originalSha256) {
    fail(
      `Refusing to patch unexpected libNativeWrapper_cef.so (${beforeHash}) at ${targetPath}.`,
    );
  }

  // Keep the temporary output beside the target so the verified replacement
  // is an atomic same-filesystem rename even when /tmp is a separate tmpfs.
  const tempDir = mkdtempSync(path.join(distDir, ".eliza-cef-hotfix-"));
  const outputPath = path.join(tempDir, "libNativeWrapper_cef.so");
  try {
    const result = spawnSync(bspatchPath, [targetPath, outputPath, patchPath], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error || result.status !== 0) {
      fail(
        `bspatch failed for ${targetPath}: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
      );
    }
    const afterHash = sha256(outputPath);
    if (afterHash !== patchedSha256) {
      fail(
        `Patched wrapper hash mismatch: expected ${patchedSha256}, got ${afterHash}.`,
      );
    }
    const mode = statSync(targetPath).mode & 0o777;
    chmodSync(outputPath, mode);
    renameSync(outputPath, targetPath);
    patchedCount += 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(
  `[patch-electrobun-linux-cef-profile] ${patchedCount > 0 ? `Patched ${patchedCount}` : "Verified"} Electrobun Linux x64 CEF wrapper${packageRoots.size === 1 ? "" : "s"}.`,
);
