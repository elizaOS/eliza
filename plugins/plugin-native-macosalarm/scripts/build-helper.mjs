#!/usr/bin/env node
// Builds the macOS alarm helper binary via `swiftc`.
//
// Outputs the binary to `bin/macosalarm-helper` inside this package so the
// TS runtime can locate it deterministically. Skips on non-darwin platforms.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "swift-helper", "main.swift");
const outDir = resolve(pkgRoot, "bin");
const outBin = resolve(outDir, "macosalarm-helper");
const moduleCacheDir = resolve(pkgRoot, ".swift-module-cache");
const tempDir = join(moduleCacheDir, "tmp");
const verbosePluginBuild = process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1";
const forceHelperBuild =
  process.env.ELIZA_MACOSALARM_FORCE_HELPER_BUILD === "1";

if (process.platform !== "darwin") {
  console.warn(
    `[macosalarm] skipping swift helper build on ${process.platform}`,
  );
  process.exit(0);
}

if (!existsSync(source)) {
  throw new Error(`macosalarm swift source missing: ${source}`);
}

if (!forceHelperBuild && existsSync(outBin)) {
  const sourceStat = statSync(source);
  const outBinStat = statSync(outBin);
  // The helper binary is checked in; skipping current binaries keeps `bun run build`
  // from dirtying the tree with non-reproducible Swift output.
  if (outBinStat.mtimeMs >= sourceStat.mtimeMs) {
    if (verbosePluginBuild) {
      console.log(`[macosalarm] helper already current: ${outBin}`);
    }
    process.exit(0);
  }
}

mkdirSync(outDir, { recursive: true });
mkdirSync(tempDir, { recursive: true });

const result = spawnSync(
  "swiftc",
  [source, "-O", "-module-cache-path", moduleCacheDir, "-o", outBin],
  {
    env: {
      ...process.env,
      // Keep compiler caches inside the package so sandboxed/local builds do not
      // need write access to ~/.cache/clang.
      CLANG_MODULE_CACHE_PATH:
        process.env.CLANG_MODULE_CACHE_PATH ?? moduleCacheDir,
      TMPDIR: process.env.TMPDIR ?? tempDir,
    },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  throw new Error(`swiftc failed with status ${result.status ?? "unknown"}`);
}

if (verbosePluginBuild) {
  console.log(`[macosalarm] built ${outBin}`);
}
