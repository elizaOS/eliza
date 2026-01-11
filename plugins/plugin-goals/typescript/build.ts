#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-goals
 * Builds the TypeScript implementation for Node.js environments
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core"];

async function build(): Promise<boolean> {
  console.log("Building @elizaos/plugin-goals...");

  const distDir = join(process.cwd(), "dist");
  const nodeDir = join(distDir, "node");

  // Clean dist directory
  if (existsSync(distDir)) {
    await Bun.$`rm -rf ${distDir}`;
  }

  await mkdir(nodeDir, { recursive: true });

  // Build Node.js ESM bundle
  const nodeResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: nodeDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
    naming: {
      entry: "index.node.js",
    },
  });

  if (!nodeResult.success) {
    console.error("Build failed:");
    for (const log of nodeResult.logs) {
      console.error(log);
    }
    return false;
  }

  console.log(`Build successful: ${nodeResult.outputs.length} files generated`);

  // Generate TypeScript declarations using tsc
  console.log("Generating TypeScript declarations...");
  const tscResult = await Bun.$`tsc -p tsconfig.build.json`.quiet().nothrow();

  if (tscResult.exitCode !== 0) {
    console.warn("Warning: TypeScript declaration generation had issues:");
    console.warn(tscResult.stderr.toString());
  }

  console.log("Build complete!");
  return true;
}

build()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
