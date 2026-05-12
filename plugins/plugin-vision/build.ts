#!/usr/bin/env bun

/**
 * Build script using bun build
 * Uses Bun.build for bundling
 */

import { $ } from "bun";
import { buildConfig, workersConfig } from "./build.config";

async function build() {
  console.log("🏗️  Building package...");

  // Clean dist directory
  await $`rm -rf dist`;

  // Build main package
  console.log("📦 Building main package...");
  const mainResult = await Bun.build(buildConfig);

  if (!mainResult.success) {
    console.error("❌ Main build failed:");
    for (const message of mainResult.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${mainResult.outputs.length} main files`);

  // Check if workers exist before building them
  const { existsSync, readdirSync } = await import("node:fs");
  const workersDir = "src/workers";
  if (existsSync(workersDir)) {
    const files = readdirSync(workersDir);
    const workerFiles = files.filter((f) => f.endsWith(".ts"));
    if (workerFiles.length > 0) {
      console.log("👷 Building workers...");
      const workersResult = await Bun.build(workersConfig);

      if (!workersResult.success) {
        console.error("❌ Workers build failed:");
        for (const message of workersResult.logs) {
          console.error(message);
        }
        process.exit(1);
      }

      console.log(`✅ Built ${workersResult.outputs.length} worker files`);
    }
  }

  // Generate TypeScript declarations
  console.log("📝 Generating TypeScript declarations...");
  const dtsResult = await $`tsc --project tsconfig.build.json`.nothrow();
  if (dtsResult.exitCode !== 0) {
    console.warn("⚠️ TypeScript declarations had warnings (non-blocking)");
  } else {
    console.log("✅ TypeScript declarations generated");
  }

  console.log("✅ Build complete!");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
