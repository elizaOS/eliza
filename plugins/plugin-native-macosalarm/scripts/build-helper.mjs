#!/usr/bin/env node
// Builds the macOS alarm helper binary via `swiftc`.
//
// Outputs the binary to `bin/macosalarm-helper` inside this package so the
// TS runtime can locate it deterministically. Skips on non-darwin platforms.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "swift-helper", "main.swift");
const outDir = resolve(pkgRoot, "bin");
const outBin = resolve(outDir, "macosalarm-helper");
const outStamp = resolve(outDir, "macosalarm-helper.source.sha256");
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

const sourceHash = createHash("sha256")
  .update(readFileSync(source))
  .digest("hex");

// Keyed on the source's content, not on its timestamp. The helper binary and
// its source are both tracked, and git assigns every file the checkout time —
// so an mtime comparison here decided whether `swiftc` ran based on which of
// the two git happened to write first, milliseconds apart. That made the build
// succeed or fail at random on a fresh clone, worktree, CI cache restore or
// `cp -r`, none of which preserve relative mtimes (#23776).
if (!forceHelperBuild && existsSync(outBin) && existsSync(outStamp)) {
  const stamped = readFileSync(outStamp, "utf8").trim();
  if (stamped === sourceHash) {
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

// Record what this binary was built from, so the next build can tell whether it
// is current without consulting a timestamp.
writeFileSync(outStamp, `${sourceHash}\n`);

if (verbosePluginBuild) {
  console.log(`[macosalarm] built ${outBin}`);
}
