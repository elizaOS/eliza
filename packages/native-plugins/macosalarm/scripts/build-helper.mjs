#!/usr/bin/env node
// Builds the macOS alarm helper binary via `swiftc`.
//
// Outputs the binary to `bin/macosalarm-helper` inside this package so the
// TS runtime can locate it deterministically. Skips on non-darwin platforms.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "swift-helper", "main.swift");
const outDir = resolve(pkgRoot, "bin");
const outBin = resolve(outDir, "macosalarm-helper");
const verbosePluginBuild =
  process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1" ||
  process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1";

if (process.platform !== "darwin") {
  console.warn(
    `[macosalarm] skipping swift helper build on ${process.platform}`,
  );
  process.exit(0);
}

if (!existsSync(source)) {
  throw new Error(`macosalarm swift source missing: ${source}`);
}

mkdirSync(outDir, { recursive: true });

const result = spawnSync("swiftc", [source, "-O", "-o", outBin], {
  stdio: "inherit",
});

if (result.status !== 0) {
  throw new Error(`swiftc failed with status ${result.status ?? "unknown"}`);
}

if (verbosePluginBuild) {
  console.log(`[macosalarm] built ${outBin}`);
}
