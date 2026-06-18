#!/usr/bin/env bun

/**
 * Standalone build script for @elizaos/plugin-whatsapp.
 * Uses Bun's native bundler — no monorepo build-utils dependency.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

rmSync("dist", { force: true, recursive: true });

const external = await externalsFromPackageJson("./package.json", {
  // Preserve bare-string node builtins, transitive workspace packages, and
  // optional native sub-packages the hand-list relied on. The
  // `@node-llama-cpp/*` glob covers per-platform subpackages that aren't
  // direct deps but must stay external so absent platforms don't fail
  // to resolve.
  extra: [
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
    "@elizaos/shared",
    "@elizaos/agent",
    "@elizaos/vault",
    "@elizaos/cloud-routing",
    "node-llama-cpp",
    "@node-llama-cpp/*",
    "@napi-rs/keyring",
    "@reflink/reflink",
    "ipull",
    "tailwindcss",
    "zlib-sync",
  ],
});

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external,
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
