#!/usr/bin/env bun
import { $ } from "bun";
import { rmSync, renameSync } from "node:fs";
import { mkdirSync } from "node:fs";

const external = [/^@elizaos\//];

console.log("🔨 Building @elizaos/plugin-wallet...");
const start = Date.now();

rmSync("dist", { recursive: true, force: true });

// Build all entrypoints together
const result = await Bun.build({
  entrypoints: [
    "src/index.ts",
    "src/sdk/index.ts",
    "src/wallet-action.ts",
    "src/lib/server-wallet-trade.ts",
  ],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external,
  minify: false,
  splitting: false,
  naming: "[dir]/[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// The primary export expects dist/index.mjs — rename it.
// Bun outputs dist/index.js; rename to dist/index.mjs.
renameSync("dist/index.js", "dist/index.mjs");
if (
  await Bun.file("dist/index.js.map").exists().catch(() => false)
) {
  renameSync("dist/index.js.map", "dist/index.mjs.map");
}

console.log("📝 Generating TypeScript declarations...");
// wallet tsconfig has noEmit: true — override with --noEmit false, set outDir + rootDir explicitly
await $`tsc --emitDeclarationOnly --declaration --noEmit false --outDir dist --rootDir src --noCheck --skipLibCheck -p tsconfig.json`.quiet();

console.log(`✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`);
