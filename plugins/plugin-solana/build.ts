#!/usr/bin/env bun
/**
 * Multi-language build script for @elizaos/plugin-solana
 * Builds TypeScript, Rust (optional), and Python (optional) implementations.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Build TypeScript implementation
 */
async function buildTypeScript(): Promise<boolean> {
  console.log("\n🔷 Building TypeScript...");
  const t0 = performance.now();

  try {
    // Run the typescript build script
    await $`cd typescript && bun run build.ts`;
    const dt = performance.now() - t0;
    console.log(`✅ TypeScript build complete in ${fmt(dt)}`);
    return true;
  } catch (error) {
    console.error("❌ TypeScript build failed:", error);
    return false;
  }
}

/**
 * Build Rust implementation (if present)
 */
async function buildRust(): Promise<boolean> {
  const rustDir = join(process.cwd(), "rust");
  if (!existsSync(join(rustDir, "Cargo.toml"))) {
    console.log("\n⏭️  Skipping Rust build (no Cargo.toml found)");
    return true;
  }

  console.log("\n🦀 Building Rust...");
  const t0 = performance.now();

  try {
    // Build Rust library
    await $`cd rust && cargo build --release`;
    const dt = performance.now() - t0;
    console.log(`✅ Rust build complete in ${fmt(dt)}`);
    return true;
  } catch (error) {
    console.error("❌ Rust build failed:", error);
    return false;
  }
}

/**
 * Build Python implementation (if present)
 */
async function buildPython(): Promise<boolean> {
  const pythonDir = join(process.cwd(), "python");
  if (!existsSync(join(pythonDir, "pyproject.toml"))) {
    console.log("\n⏭️  Skipping Python build (no pyproject.toml found)");
    return true;
  }

  console.log("\n🐍 Building Python...");
  const t0 = performance.now();

  try {
    // Build Python package
    await $`cd python && python3 -m build --sdist`;
    const dt = performance.now() - t0;
    console.log(`✅ Python build complete in ${fmt(dt)}`);
    return true;
  } catch (error) {
    console.error("❌ Python build failed:", error);
    return false;
  }
}

/**
 * Main build orchestration
 */
async function main(): Promise<void> {
  const totalStart = Date.now();
  console.log("🏗️  Building @elizaos/plugin-solana (multi-language)");

  // TypeScript is always required
  const tsOk = await buildTypeScript();
  if (!tsOk) {
    console.error("\n💥 Build failed: TypeScript build required");
    process.exit(1);
  }

  // Rust and Python are optional
  const rustOk = await buildRust();
  const pythonOk = await buildPython();

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(2);

  if (!rustOk || !pythonOk) {
    console.log(
      `\n⚠️  Build completed with warnings in ${totalTime}s (some optional languages failed)`,
    );
    process.exit(0); // Don't fail on optional builds
  }

  console.log(`\n🎉 All builds complete in ${totalTime}s`);
}

main().catch((error) => {
  console.error("Build orchestration failed:", error);
  process.exit(1);
});
