#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");

async function buildPlugin() {
  console.log("🔨 Building @elizaos/plugin-n8n...\n");

  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }

  console.log("Compiling TypeScript...");
  try {
    execSync("bunx tsc -p tsconfig.build.json", { stdio: "inherit" });
  } catch {
    console.error("TypeScript compilation failed");
    process.exit(1);
  }

  console.log("\n✅ Build complete!");
}

buildPlugin().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
