#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-github
 * Uses Bun.build for bundling
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = [
  "@elizaos/core",
  "simple-git",
  "@octokit/rest",
  "@octokit/types",
  "@octokit/webhooks-types",
  "glob",
  "zod",
];

async function build() {
  console.log("🔨 Building @elizaos/plugin-github...\n");

  const distDir = join(process.cwd(), "dist");

  // Clean dist directory
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }

  // Build with Bun
  console.log("📦 Bundling with Bun...");
  const buildResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!buildResult.success) {
    console.error("Build failed:");
    for (const log of buildResult.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${buildResult.outputs.length} file(s)`);

  // Generate type declarations
  console.log("📝 Generating type declarations...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await tscProcess.exited;

  if (tscProcess.exitCode !== 0) {
    console.warn("TypeScript declaration generation had warnings (skipping)");
  }

  console.log("\n✅ Build complete!");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
