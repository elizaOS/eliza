#!/usr/bin/env bun

/**
 * Standalone build for @elizaos/plugin-clanker.
 * Uses Bun bundler for runtime; runs tsc for declarations.
 */

import { execSync } from "node:child_process";
const EXTERNALS = [
  "@elizaos/core",
  "clanker-sdk",
  "clanker-sdk/v4",
  "dotenv",
  "ethers",
  "http",
  "https",
  "viem",
  "viem/accounts",
  "viem/chains",
  "zod",
];

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external: EXTERNALS,
  sourcemap: "linked",
  minify: false,
});

if (!result.success) {
  console.error("[plugin-clanker] runtime build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

execSync("bunx tsc -p tsconfig.build.json --emitDeclarationOnly", {
  stdio: "inherit",
});

console.log("[plugin-clanker] build complete");
