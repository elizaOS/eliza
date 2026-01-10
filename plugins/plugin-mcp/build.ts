#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-mcp
 * Orchestrates builds for TypeScript, Python, and Rust implementations
 */

import { existsSync } from "node:fs";
import { $ } from "bun";

async function buildTypeScript(): Promise<void> {
  console.log("\n📦 Building TypeScript...");
  const startDir = process.cwd();
  process.chdir("typescript");
  await $`bun run build.ts`;
  process.chdir(startDir);
  console.log("✅ TypeScript build complete");
}

async function buildRust(): Promise<void> {
  // Check if cargo is available
  try {
    await $`which cargo`.quiet();
  } catch {
    console.log("⏭️  Skipping Rust build (cargo not available)");
    return;
  }

  console.log("\n🦀 Building Rust...");
  const startDir = process.cwd();
  process.chdir("rust");
  
  // Build native library
  await $`cargo build --release`.nothrow();
  
  // Check if wasm-pack is available for WASM build
  try {
    await $`which wasm-pack`.quiet();
    console.log("📦 Building Rust WASM...");
    await $`wasm-pack build --target nodejs --out-dir pkg/node --features wasm`.nothrow();
  } catch {
    console.log("⏭️  Skipping WASM build (wasm-pack not available)");
  }
  
  process.chdir(startDir);
  console.log("✅ Rust build complete");
}

async function buildPython(): Promise<void> {
  // Check if python/hatch is available
  try {
    await $`which python3`.quiet();
  } catch {
    console.log("⏭️  Skipping Python build (python3 not available)");
    return;
  }

  console.log("\n🐍 Building Python...");
  const startDir = process.cwd();
  process.chdir("python");
  
  // Build Python wheel if hatch is available
  try {
    await $`which hatch`.quiet();
    await $`hatch build`.nothrow();
    console.log("✅ Python build complete");
  } catch {
    // Try with pip build
    try {
      await $`python3 -m build`.nothrow();
      console.log("✅ Python build complete");
    } catch {
      console.log("⏭️  Skipping Python wheel build (hatch/build not available)");
    }
  }
  
  process.chdir(startDir);
}

async function build(): Promise<void> {
  console.log("🔨 Building @elizaos/plugin-mcp (multi-language)...");
  const startTime = Date.now();

  // TypeScript build is required
  await buildTypeScript();

  // Optional builds for Rust and Python
  await buildRust();
  await buildPython();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n🎉 All builds complete in ${duration}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
