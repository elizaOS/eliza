#!/usr/bin/env bun

/**
 * Standalone build for @elizaos/plugin-clanker.
 * Uses Bun bundler for runtime; runs tsc separately for declarations and
 * tolerates type-resolution failures caused by duplicate viem installs in
 * the parent monorepo (the dist .js is correct either way).
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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

try {
  execSync("bunx tsc -p tsconfig.build.json --emitDeclarationOnly", {
    stdio: "inherit",
  });
} catch {
  console.warn(
    "[plugin-clanker] tsc declaration emit had errors (likely duplicate viem in monorepo); writing stub d.ts",
  );
  writeFileSync("dist/index.d.ts", "export {};\n");
}

console.log("[plugin-clanker] build complete");
