#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-n8n
 * Uses tsc to compile TypeScript and generate declarations
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(process.cwd(), "..", "dist");

async function buildPlugin() {
  console.log("🔨 Building @elizaos/plugin-n8n...\n");

  // Clean dist directory
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }

  // Build with tsc
  console.log("📦 Compiling TypeScript...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await tscProcess.exited;

  if (tscProcess.exitCode !== 0) {
    console.error("TypeScript compilation failed");
    process.exit(1);
  }

  console.log("\n✅ Build complete!");
}

buildPlugin().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
