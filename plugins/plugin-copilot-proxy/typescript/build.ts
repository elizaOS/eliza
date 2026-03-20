#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-copilot-proxy TypeScript package
 */

const externalDeps = ["@elizaos/core", "@ai-sdk/openai-compatible", "ai"];

async function build(): Promise<void> {
  const totalStart = Date.now();

  // Node ESM build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-copilot-proxy for Node (ESM)...");

  const nodeResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!nodeResult.success) {
    console.error("Node ESM build failed:", nodeResult.logs);
    throw new Error("Node ESM build failed");
  }

  console.log(
    `✅ Node ESM build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`,
  );

  // Generate TypeScript declarations
  console.log("📝 Generating TypeScript declarations...");

  const { $ } = await import("bun");
  await $`tsc --project tsconfig.json`.nothrow();

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(2);
  console.log(`🎉 All builds finished in ${totalTime}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
