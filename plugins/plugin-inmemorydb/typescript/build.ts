#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-inmemorydb
 *
 * Builds for both Node.js and browser targets since
 * the in-memory storage works identically in both environments.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateDts, runBuild } from "../../../build-utils";

// Get the plugin root directory (one level up from typescript)
const PLUGIN_ROOT = resolve(dirname(import.meta.path), "..");

async function buildAll() {
  // Change to plugin root directory for build
  const originalCwd = process.cwd();
  process.chdir(PLUGIN_ROOT);

  try {
    // Node build
    const nodeOk = await runBuild({
      packageName: "@elizaos/plugin-inmemorydb",
      buildOptions: {
        entrypoints: ["typescript/index.ts"],
        outdir: "typescript/dist/node",
        target: "node",
        format: "esm",
        external: ["@elizaos/core"],
        sourcemap: true,
        minify: false,
        generateDts: false, // Handle DTS generation manually
      },
    });

    if (!nodeOk) return false;

    // Browser build (same source, just different target)
    const browserOk = await runBuild({
      packageName: "@elizaos/plugin-inmemorydb",
      buildOptions: {
        entrypoints: ["typescript/index.ts"],
        outdir: "typescript/dist/browser",
        target: "browser",
        format: "esm",
        external: ["@elizaos/core"],
        sourcemap: true,
        minify: false,
        generateDts: false, // Handle DTS generation manually
      },
    });

    if (!browserOk) return false;

    // Generate TypeScript declarations
    console.log("📝 Generating type declarations...");
    await generateDts("typescript/tsconfig.build.json", false);

    // Ensure declaration entry points are present for consumers
    const distDir = join(PLUGIN_ROOT, "typescript", "dist");
    const browserDir = join(distDir, "browser");
    const nodeDir = join(distDir, "node");

    if (!existsSync(browserDir)) {
      await mkdir(browserDir, { recursive: true });
    }
    if (!existsSync(nodeDir)) {
      await mkdir(nodeDir, { recursive: true });
    }

    // Root types alias to node by default
    const rootIndexDtsPath = join(distDir, "index.d.ts");
    const rootAlias = [
      'export * from "./node/index";',
      'export { default } from "./node/index";',
      "",
    ].join("\n");
    await writeFile(rootIndexDtsPath, rootAlias, "utf8");

    // Browser alias
    const browserIndexDtsPath = join(browserDir, "index.d.ts");
    const browserAlias = [
      'export * from "./index";',
      'export { default } from "./index";',
      "",
    ].join("\n");
    await writeFile(browserIndexDtsPath, browserAlias, "utf8");

    // Node alias
    const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
    const nodeAlias = ['export * from "./index";', 'export { default } from "./index";', ""].join(
      "\n"
    );
    await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

    return true;
  } finally {
    // Restore original working directory
    process.chdir(originalCwd);
  }
}

buildAll()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
