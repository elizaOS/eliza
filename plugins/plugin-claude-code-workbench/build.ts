#!/usr/bin/env bun
/**
 * Self-contained build script for Claude Code workbench plugin
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { $ } from "bun";

async function cleanBuild(outdir = "dist") {
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`✓ Cleaned ${outdir} directory`);
  }
}

async function build() {
  const start = performance.now();
  console.log("🚀 Building plugin-claude-code-workbench...");

  try {
    await cleanBuild("dist");

    console.log("Starting build tasks...");

    const [buildResult] = await Promise.all([
      (async () => {
        console.log("📦 Bundling with Bun...");
        const result = await Bun.build({
          entrypoints: ["./src/index.ts"],
          outdir: "./dist",
          target: "node",
          format: "esm",
          sourcemap: true,
          minify: false,
          external: ["node:*", "@elizaos/core", "zod"],
          naming: {
            entry: "[dir]/[name].[ext]",
          },
        });

        if (!result.success) {
          console.error("✗ Build failed:", result.logs);
          return { success: false, outputs: [] };
        }

        const totalSize = result.outputs.reduce(
          (sum, output) => sum + output.size,
          0,
        );
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB`);

        return result;
      })(),

      (async () => {
        console.log("📝 Generating TypeScript declarations...");
        try {
          await $`bunx tsc --emitDeclarationOnly --incremental --project ./tsconfig.build.json`.quiet();
          console.log("✓ TypeScript declarations generated");
          return { success: true };
        } catch {
          console.warn("⚠ Failed to generate TypeScript declarations");
          return { success: false };
        }
      })(),
    ]);

    if (!buildResult.success) {
      return false;
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`✅ Build complete! (${elapsed}s)`);
    return true;
  } catch (error) {
    console.error("Build error:", error);
    return false;
  }
}

build()
  .then((success) => {
    if (!success) {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
