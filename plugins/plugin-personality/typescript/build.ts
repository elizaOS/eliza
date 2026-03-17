#!/usr/bin/env bun

/**
 * Build script using bun build
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { buildConfig } from "./build.config";

async function build() {
  console.log("Building @elizaos/plugin-personality...");

  const distDir = join(process.cwd(), "dist");
  const nodeDir = join(distDir, "node");

  if (existsSync(distDir)) {
    await $`rm -rf ${distDir}`;
  }

  await mkdir(nodeDir, { recursive: true });

  // Build with bun
  const result = await Bun.build(buildConfig);

  if (!result.success) {
    console.error("Build failed:");
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`Build successful: ${result.outputs.length} files generated`);

  // Generate TypeScript declarations
  console.log("Generating TypeScript declarations...");
  try {
    await $`tsc --project tsconfig.build.json`;
    console.log("TypeScript declarations generated");
  } catch (error) {
    console.warn(
      "TypeScript declaration generation had issues, but continuing...",
    );
  }

  console.log("Build complete!");
}

build().catch(console.error);
