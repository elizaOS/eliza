#!/usr/bin/env bun
// P1c — Replace app-core's 100+ subpath exports with a single barrel `.` export.
// Also rebuild app-core/src/index.ts to re-export everything still in the package
// after p1a's moves (i.e. the node-side surface).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  parseFlags,
  preflight,
  readJson,
  writeFileIfChanged,
  writeJson,
} from "./lib/util.mjs";

const APP_CORE_DIR = "packages/app-core";

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p1-collapse-app-core-exports", flags, log);
  const stats = new Stats();

  // 1) Collapse package.json exports
  log.section("Collapse @elizaos/app-core/package.json exports");
  const pkgPath = join(REPO_ROOT, APP_CORE_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    log.error(`${pkgPath} missing`);
    process.exit(1);
  }
  const pkg = readJson(pkgPath);
  const oldExportCount = Object.keys(pkg.exports ?? {}).length;
  pkg.exports = {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
    "./package.json": "./package.json",
  };
  // While we're here, point main/types at dist (P3 will also do this; harmless duplicate)
  pkg.main = "./dist/index.js";
  pkg.module = "./dist/index.js";
  pkg.types = "./dist/index.d.ts";
  // Ensure files: ["dist"] so npm publishes only the build
  if (!Array.isArray(pkg.files)) pkg.files = [];
  if (!pkg.files.includes("dist")) pkg.files.push("dist");
  writeJson(pkgPath, pkg, flags, log);
  stats.incr("subpath exports removed", oldExportCount - 2);

  // 2) Rebuild src/index.ts to re-export every remaining subdir's index
  log.section("Rebuild app-core/src/index.ts barrel");
  const indexPath = join(REPO_ROOT, APP_CORE_DIR, "src/index.ts");
  const newBarrel = buildBarrel(join(REPO_ROOT, APP_CORE_DIR, "src"));
  log.info(`barrel will export ${newBarrel.split("\n").filter(Boolean).length} subpaths`);
  writeFileIfChanged(indexPath, newBarrel, flags, log);
  stats.incr("barrel rebuilt", 1);

  stats.print(log);
}

/**
 * Walk app-core/src/* (top-level dirs and top-level files) and emit
 * `export * from "./<x>";` for each one that has an index.ts or is itself a .ts file.
 *
 * This is the "everything in the barrel" approach. If you want to be selective,
 * curate this list manually after the script runs.
 */
function buildBarrel(srcDir) {
  if (!existsSync(srcDir)) return "// (app-core src missing)\n";
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const exports = [];
  // Top-level files (excluding index)
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.startsWith("index.")) continue;
    const stem = entry.name.replace(/\.tsx?$/, "");
    exports.push(`export * from "./${stem}";`);
  }
  // Top-level subdirs that have an index file
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const idxTs = join(srcDir, entry.name, "index.ts");
    const idxTsx = join(srcDir, entry.name, "index.tsx");
    if (existsSync(idxTs) || existsSync(idxTsx)) {
      exports.push(`export * from "./${entry.name}";`);
    }
  }
  exports.sort();
  return [
    "// Barrel rebuilt by scripts/refactor/p1-collapse-app-core-exports.mjs.",
    "// Exports every top-level node-side module in @elizaos/app-core.",
    "// Frontend code lives in @elizaos/ui; pure types/utils in @elizaos/shared.",
    "",
    ...exports,
    "",
  ].join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
