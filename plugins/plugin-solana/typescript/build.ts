#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-solana TypeScript
 */

import { $ } from "bun";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Run TypeScript type-checker (no emit)
 */
async function typecheck(): Promise<void> {
  const t0 = performance.now();
  console.log("▶︎ Type-checking with tsc…");
  try {
    await $`tsc --noEmit -p tsconfig.json`;
    const dt = performance.now() - t0;
    console.log(`⏱️  Type-check done in ${fmt(dt)}`);
  } catch {
    const dt = performance.now() - t0;
    console.error(`✖ Type-check failed after ${fmt(dt)}`);
    process.exit(1);
  }
}

/**
 * Build the TypeScript package
 */
async function build(): Promise<void> {
  const totalStart = Date.now();

  // Load package.json and auto-generate externals from dependencies
  const pkg = await Bun.file("../package.json").json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  // Clean previous build
  await $`rm -rf ../dist`;
  await $`mkdir -p ../dist`;

  // ESM build
  const esmStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-solana (ESM)...");
  const esmResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "../dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!esmResult.success) {
    console.error("ESM build errors:", esmResult.logs);
    throw new Error("ESM build failed");
  }
  console.log(
    `✅ ESM build complete in ${((Date.now() - esmStart) / 1000).toFixed(2)}s`,
  );

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  await $`tsc --project tsconfig.build.json`;
  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`,
  );

  console.log(
    `🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}

// Run typecheck first, then build
await typecheck();

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});


