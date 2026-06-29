#!/usr/bin/env bun

/**
 * Build script using bun build
 * Uses Bun.build for bundling
 */

import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const NODE_BUILTINS = [
  "fs",
  "path",
  "http",
  "https",
  "crypto",
  "node:fs",
  "node:path",
  "node:http",
  "node:https",
  "node:crypto",
  "node:stream",
  "node:buffer",
  "node:util",
  "node:events",
  "node:url",
] as const;

async function build() {
  console.log("🏗️  Building package...");

  // Clean dist directory
  await $`node ../../packages/scripts/rm-path-recursive.mjs dist`;

  // Externalize plugin-computeruse even though it is NOT a package.json
  // dependency: plugin-vision dynamically imports its OCR seam
  // (`@elizaos/plugin-computeruse/mobile/ocr-provider`) at boot via a
  // best-effort import. It MUST stay external so the registry singleton is the
  // one runtime instance computeruse reads — bundling a copy would split the
  // registry and the registration would be invisible to computeruse.
  const OPTIONAL_PEERS = ["@elizaos/plugin-computeruse"] as const;
  const external = await externalsFromPackageJson("./package.json", {
    extra: [...NODE_BUILTINS, ...OPTIONAL_PEERS],
  });

  // Build main package
  console.log("📦 Building main package...");
  const mainResult = await Bun.build({
    // index.ts is the package entry; som.ts is also a published subpath
    // (`@elizaos/plugin-vision/som`, #9170 M9) consumed by computeruse's
    // detect_elements/grounding, so emit it as its own dist entrypoint.
    entrypoints: ["./src/index.ts", "./src/som.ts"],
    outdir: "./dist",
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    external,
    naming: "[dir]/[name].[ext]",
  });

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
      const workersResult = await Bun.build({
        entrypoints: [
          "./src/workers/screen-capture-worker.ts",
          "./src/workers/ocr-worker.ts",
        ],
        outdir: "./dist/workers",
        target: "node",
        format: "cjs", // Workers need CommonJS format
        splitting: false,
        sourcemap: true,
        external: [
          ...external,
          "@mapbox/node-pre-gyp",
          "mock-aws-s3",
          "aws-sdk",
          "nock",
        ],
        naming: "[name].[ext]",
      });

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
  const dtsResult =
    await $`tsc --project tsconfig.build.json --noCheck`.nothrow();
  if (dtsResult.exitCode !== 0) {
    console.error("❌ TypeScript declarations failed");
    process.exit(dtsResult.exitCode);
  }
  console.log("✅ TypeScript declarations generated");

  console.log("✅ Build complete!");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
