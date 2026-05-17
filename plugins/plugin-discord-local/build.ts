#!/usr/bin/env bun

/**
 * Standalone build script for @elizaos/plugin-discord-local.
 * Uses Bun's native bundler — no monorepo build-utils dependency.
 */

import { execSync } from "node:child_process";

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
    // Core / agent dependencies
    "@elizaos/core",
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
  execSync("bunx tsc -p tsconfig.build.json", { stdio: "inherit" });
} catch {
  // Non-fatal — plugin works at runtime without .d.ts files
  console.warn("[plugin-discord-local] tsc declaration emit failed (non-fatal)");
}

console.log("[plugin-discord-local] Build complete");
