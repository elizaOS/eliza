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
    // Core dependency
    "@elizaos/core",
    // Runtime dependencies (resolved from node_modules at runtime)
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
  execSync("bunx tsc -p tsconfig.build.json", { stdio: "inherit" });
} catch {
  // Non-fatal — plugin works at runtime without .d.ts files
  console.warn("[plugin-whatsapp] tsc declaration emit failed (non-fatal)");
}

console.log("[plugin-whatsapp] Build complete");
