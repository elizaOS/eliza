#!/usr/bin/env bun

/**
 * Standalone build script for @elizaos/plugin-whatsapp.
 * Uses Bun's native bundler — no monorepo build-utils dependency.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist", { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external: [
    // Node builtins
    "fs",
    "path",
    "os",
    "http",
    "https",
    "crypto",
    "stream",
    "events",
    "util",
    "url",
    "net",
    "tls",
    "zlib",
    "buffer",
    "child_process",
    "readline",
    // Workspace packages — never bundle @elizaos/* into a plugin output;
    // they're resolved from node_modules at runtime.
    "@elizaos/core",
    "@elizaos/shared",
    "@elizaos/agent",
    "@elizaos/vault",
    "@elizaos/cloud-routing",
    // Heavy native libs; the `node-llama-cpp` package ships per-platform
    // optional sub-packages that are only present on the matching host.
    // Marking the parent + sub-package wildcards keeps Bun.build from
    // resolving the absent platforms.
    "node-llama-cpp",
    "@node-llama-cpp/linux-arm64",
    "@node-llama-cpp/linux-armv7l",
    "@node-llama-cpp/linux-x64",
    "@node-llama-cpp/linux-x64-cuda",
    "@node-llama-cpp/linux-x64-cuda-ext",
    "@node-llama-cpp/linux-x64-vulkan",
    "@node-llama-cpp/mac-arm64-metal",
    "@node-llama-cpp/mac-x64",
    "@node-llama-cpp/win-arm64",
    "@node-llama-cpp/win-x64",
    "@node-llama-cpp/win-x64-cuda",
    "@node-llama-cpp/win-x64-cuda-ext",
    "@node-llama-cpp/win-x64-vulkan",
    "@huggingface/transformers",
    "onnxruntime-node",
    "@napi-rs/keyring",
    "@reflink/reflink",
    "ipull",
    "tailwindcss",
    "zlib-sync",
    // Runtime dependencies (resolved from node_modules at runtime)
    "axios",
    "@hapi/boom",
    "@whiskeysockets/baileys",
    "pino",
    "qrcode",
    "qrcode-terminal",
  ],
  sourcemap: "linked",
  minify: false,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Emit real declaration files via tsc
try {
  execSync("bunx tsc --noCheck -p tsconfig.build.json", { stdio: "inherit" });
} catch {
  // Non-fatal — plugin works at runtime without .d.ts files
  console.warn("[plugin-whatsapp] tsc declaration emit failed (non-fatal)");
}

console.log("[plugin-whatsapp] Build complete");
