#!/usr/bin/env bun
/**
 * Build script for plugin-computeruse
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

const externalDeps = await externalsFromPackageJson("./package.json", {
  extra: ["node:*"],
});

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${target} with status ${result.status}`,
    );
  }
}

async function cleanBuild(outdir = "dist") {
  if (existsSync(outdir)) {
    rmRecursive(outdir);
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
        for (const { entrypoint, outdir } of [
          { entrypoint: "./src/index.ts", outdir: "./dist" },
          { entrypoint: "./src/register-routes.ts", outdir: "./dist" },
          {
            entrypoint: "./src/mobile/ocr-provider.ts",
            outdir: "./dist/mobile",
          },
        ]) {
          const result = await Bun.build({
            entrypoints: [entrypoint],
            outdir,
            target: "node",
            format: "esm",
            sourcemap: "linked",
            minify: false,
            external: externalDeps,
            naming: {
              entry: "[name].[ext]",
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
