#!/usr/bin/env bun
/**
 * Build script for plugin-computeruse
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { $ } from "bun";

async function cleanBuild(outdir = "dist") {
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`Cleaned ${outdir} directory`);
  }
  if (existsSync("tsconfig.build.tsbuildinfo")) {
    await rm("tsconfig.build.tsbuildinfo", { force: true });
  }
}

async function build() {
  const start = performance.now();
  console.log("Building plugin-computeruse...");

  try {
    await cleanBuild("dist");

    const [buildResult, declResult] = await Promise.all([
      (async () => {
        console.log("Bundling with Bun...");
        const outputs: BuildArtifact[] = [];
        for (const entrypoint of [
          "./src/index.ts",
          "./src/register-routes.ts",
        ]) {
          const result = await Bun.build({
            entrypoints: [entrypoint],
            outdir: "./dist",
            target: "node",
            format: "esm",
            sourcemap: "linked",
            minify: false,
            external: ["node:*", "@elizaos/core", "puppeteer-core"],
            naming: {
              entry: "[dir]/[name].[ext]",
            },
          });

          if (!result.success) {
            console.error("Build failed:", result.logs);
            return { success: false, outputs };
          }
          outputs.push(...result.outputs);
        }

        const totalSize = outputs.reduce((sum, output) => sum + output.size, 0);
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`Built ${outputs.length} file(s) - ${sizeMB}MB`);

        return { success: true, outputs };
      })(),

      (async () => {
        console.log("Generating TypeScript declarations...");
        try {
          await $`bunx tsc --noCheck --emitDeclarationOnly --incremental --project ./tsconfig.build.json`;
          console.log("TypeScript declarations generated");
          return { success: true };
        } catch (e) {
          console.error("TypeScript declaration generation failed", e);
          return { success: false };
        }
      })(),
    ]);

    if (!buildResult.success || !declResult.success) {
      process.exit(1);
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`Build complete! (${elapsed}s)`);
  } catch (error) {
    console.error("Build error:", error);
    process.exit(1);
  }
}

build();
