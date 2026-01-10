#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-roblox
 *
 * This script builds the TypeScript source for Node.js.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core", "zod"];

async function build() {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "..", "dist");

  // Ensure dist directory exists
  if (!existsSync(distDir)) {
    await mkdir(distDir, { recursive: true });
  }

  // Node build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-roblox...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!nodeResult.success) {
    console.error("Build failed:", nodeResult.logs);
    throw new Error("Build failed");
  }
  console.log(
    `✅ Build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`
  );

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;
  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`
  );

  console.log(
    `🎉 All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

export {};

