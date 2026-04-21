#!/usr/bin/env bun

/**
 * Build script for rust-plugin-starter
 *
 * This script:
 * 1. Builds the Rust plugin to WASM
 * 2. Uses wasm-bindgen to generate JavaScript bindings
 * 3. Compiles TypeScript
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const projectRoot = import.meta.dir;
const distDir = join(projectRoot, "dist");
const wasmTarget = "wasm32-unknown-unknown";

console.log("🔨 Building Rust plugin starter...");

// Step 0: Check if wasm32-unknown-unknown target is installed
console.log("🎯 Checking for WASM target...");
try {
  const result = await $`rustup target list --installed`.quiet();
  if (!result.stdout.toString().includes("wasm32-unknown-unknown")) {
    console.log("⚠️  wasm32-unknown-unknown target not found. Installing...");
    await $`rustup target add wasm32-unknown-unknown`;
    console.log("✅ WASM target installed");
  }
} catch {
  console.error("❌ Rust build skipped - rustup not available or failed to add WASM target");
  console.log("   Please install manually: rustup target add wasm32-unknown-unknown");
  console.log("   Skipping Rust WASM build...");
  process.exit(0);
}

// Step 1: Check if wasm-bindgen-cli is installed
console.log("📦 Checking for wasm-bindgen-cli...");
try {
  await $`wasm-bindgen --version`.quiet();
} catch {
  console.log("⚠️  wasm-bindgen-cli not found. Attempting to install...");
  try {
    await $`cargo install wasm-bindgen-cli`.cwd(projectRoot);
    console.log("✅ wasm-bindgen-cli installed");
  } catch {
    console.error("❌ Failed to install wasm-bindgen-cli");
    console.log("   Please install manually: cargo install wasm-bindgen-cli");
    process.exit(1);
  }
}

// Step 2: Build Rust to WASM
console.log("🦀 Building Rust to WASM...");
try {
  await $`cargo build --target ${wasmTarget} --release --features wasm`.cwd(
    projectRoot,
  );
  console.log("✅ Rust build complete");
} catch (error) {
  console.error("❌ Failed to build Rust:", error);
  process.exit(1);
}

// Step 3: Generate WASM bindings
console.log("🔗 Generating WASM bindings...");
const wasmFile = join(
  projectRoot,
  `target/${wasmTarget}/release/elizaos_plugin_starter.wasm`,
);

if (!existsSync(wasmFile)) {
  console.error(`❌ WASM file not found: ${wasmFile}`);
  process.exit(1);
}

try {
  // Create dist directory if it doesn't exist
  if (!existsSync(distDir)) {
    await $`mkdir -p ${distDir}`;
  }

  // Use wasm-bindgen to generate bindings for web target
  await $`wasm-bindgen ${wasmFile} --out-dir ${distDir} --target web --no-typescript`.cwd(
    projectRoot,
  );
  console.log("✅ WASM bindings generated");
} catch (error) {
  console.error("❌ Failed to generate WASM bindings:", error);
  console.error(
    "   Make sure wasm-bindgen-cli is installed: cargo install wasm-bindgen-cli",
  );
  process.exit(1);
}

// Step 4: Build TypeScript
console.log("📝 Building TypeScript...");
try {
  await $`bun run build:ts`.cwd(projectRoot);
  console.log("✅ TypeScript build complete");
} catch (error) {
  console.error("❌ Failed to build TypeScript:", error);
  process.exit(1);
}

console.log("✅ Build complete!");
console.log(`   WASM file: ${distDir}/elizaos_plugin_starter_bg.wasm`);
console.log(`   JS bindings: ${distDir}/elizaos_plugin_starter.js`);
