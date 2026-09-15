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
 * Electrobun 1.18.1's BrowserWindow also drops its `partition` option when it
 * constructs the implicit BrowserView. Patch the shipped TypeScript entrypoint
 * so Linux creates one partitioned main view instead of racing an unpartitioned
 * bootstrap view against a second, manually attached view.
 *
 * Both input and output hashes are fail-closed so a dependency update cannot
 * accidentally receive a patch built for a different native wrapper.
 * The native hotfix also closes live CEF browsers and keeps pumping the
 * external message loop before CefShutdown so queued profile writes commit.
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
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyElectrobunLinuxNativeArtifacts,
  findElectrobunBrowserWindowEntrypoints,
} from "./lib/electrobun-browser-window-entrypoints.mjs";

const requirePatch = process.argv.includes("--require");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const expectedVersion = "1.18.1";
const originalSha256 =
  "e7172d886925e4d728cf35cbee5a52ad17c33e9bb4c40248a788a0a10100df53";
const patchedSha256 =
  "40ba72d0cc6e38d04cd2ea29a650f5b3976673b2facb09fedae003b26bfdc971";
const patchSha256 =
  "b7e043197daca54f028b63fc1d05b12e6b69901a76ddbcea84adb653652d5430";
const browserWindowOriginalSha256 =
  "8c172878fd77bd2119d7958a1c2c8280bf9642c78abf8a1cbcb67fa3b03226cf";
const browserWindowPatchedSha256 =
  "583aa653d89eb01d55e9ee5b3f90c021e924827c811d119a2bf6100432e938bd";
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

function patchBrowserWindow(targetPath) {
  if (!existsSync(targetPath)) {
    fail(`Electrobun BrowserWindow entrypoint is missing: ${targetPath}`);
  }
  const beforeHash = sha256(targetPath);
  if (beforeHash === browserWindowPatchedSha256) return false;
  if (beforeHash !== browserWindowOriginalSha256) {
    fail(
      `Refusing to patch unexpected BrowserWindow.ts (${beforeHash}) at ${targetPath}.`,
    );
  }

  const original = readFileSync(targetPath, "utf8");
  const withPartitionType = original.replace(
    "\tviewsRoot: string | null;\n\trenderer:",
    "\tviewsRoot: string | null;\n\tpartition?: string | null;\n\trenderer:",
  );
  const withPartitionView = withPartitionType.replace(
    "\t\t\tviewsRoot: this.viewsRoot,\n\t\t\t// frame:",
    "\t\t\tviewsRoot: this.viewsRoot,\n\t\t\tpartition: partition || null,\n\t\t\t// frame:",
  );
  const patched = withPartitionView.replace(
    "\t\tactivate,\n\t}: Partial<WindowOptionsType<T>>) {",
    "\t\tactivate,\n\t\tpartition,\n\t}: Partial<WindowOptionsType<T>>) {",
  );
  if (patched === original) {
    fail(`BrowserWindow partition anchors were not found at ${targetPath}.`);
  }
  writeFileSync(targetPath, patched);
  if (sha256(targetPath) !== browserWindowPatchedSha256) {
    fail(`Patched BrowserWindow hash mismatch at ${targetPath}.`);
  }
  return true;
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
let browserWindowPatchedCount = 0;
let deferredNativeCount = 0;
for (const packageRoot of packageRoots) {
  const browserWindowPaths =
    findElectrobunBrowserWindowEntrypoints(packageRoot);
  if (browserWindowPaths.length === 0) {
    fail(
      `Electrobun BrowserWindow entrypoint is missing below ${packageRoot}.`,
    );
  }
  for (const browserWindowPath of browserWindowPaths) {
    if (patchBrowserWindow(browserWindowPath)) {
      browserWindowPatchedCount += 1;
    }
  }

  const { bspatchPath, distDir, state, targetPath } =
    classifyElectrobunLinuxNativeArtifacts(packageRoot);
  if (state !== "complete") {
    const message =
      state === "absent"
        ? `Electrobun Linux x64 native artifacts are not materialized yet at ${distDir}; deferring the native hotfix.`
        : `Electrobun Linux x64 native artifacts are incomplete at ${distDir}.`;
    if (requirePatch || state === "incomplete") fail(message);
    console.warn(`[patch-electrobun-linux-cef-profile] ${message}`);
    deferredNativeCount += 1;
    continue;
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
  `[patch-electrobun-linux-cef-profile] ${deferredNativeCount === packageRoots.size ? `Deferred ${deferredNativeCount}` : patchedCount > 0 ? `Patched ${patchedCount}` : "Verified"} Electrobun Linux x64 CEF wrapper${packageRoots.size === 1 ? "" : "s"}; ${browserWindowPatchedCount > 0 ? `patched ${browserWindowPatchedCount}` : "verified"} BrowserWindow entrypoint${packageRoots.size === 1 ? "s" : " sets"}.`,
);
