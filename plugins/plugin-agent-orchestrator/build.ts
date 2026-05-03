#!/usr/bin/env bun
/**
 * Self-contained build script for coding-agent plugin
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { $ } from "bun";

async function cleanBuild(outdir = "dist") {
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`✓ Cleaned ${outdir} directory`);
  }
  // Remove tsc incremental cache so declarations are re-emitted after dist/ is wiped
  if (existsSync("tsconfig.build.tsbuildinfo")) {
    await rm("tsconfig.build.tsbuildinfo", { force: true });
  }
}

async function build() {
  const start = performance.now();
  console.log("🚀 Building plugin-agent-orchestrator...");

  try {
    await cleanBuild("dist");

    console.log("Starting build tasks...");

    const [buildResult, declResult] = await Promise.all([
      (async () => {
        console.log("📦 Bundling with Bun...");
        const result = await Bun.build({
          entrypoints: ["./src/index.ts"],
          outdir: "./dist",
          target: "node",
          format: "esm",
          sourcemap: "linked",
          minify: false,
          external: [
            "node:*",
            "@elizaos/core",
            "coding-agent-adapters",
            "drizzle-orm",
            "git-workspace-service",
            "pty-manager",
            "pty-console",
            "pty-state-capture",
            "zod",
          ],
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
          await $`bunx tsc --emitDeclarationOnly --incremental --project ./tsconfig.build.json`;
          console.log("✓ TypeScript declarations generated");
          return { success: true };
        } catch (e) {
          console.error("✗ TypeScript declaration generation failed", e);
          return { success: false };
        }
      })(),
    ]);

    if (!buildResult.success) {
      return false;
    }

    if (!declResult.success) {
      console.error(
        "✗ Build aborted: TypeScript declarations could not be generated",
      );
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
