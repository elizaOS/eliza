#!/usr/bin/env bun
import { renameSync, rmSync } from "node:fs";
import { $ } from "bun";

// Externals:
//  - All @elizaos/* workspace packages stay external so we don't double-bundle them.
//  - `undici` must be external. Bundling undici 8.x produces a `CacheStorage`
//    constructor that calls Node's internal `webidl.util.markAsUncloneable`,
//    which is not present in Bun. Bun's native fetch/WebSocket cover the call
//    sites, so importing undici from the runtime works; bundling it does not.
//    Some workspace deps (notably @elizaos/plugin-elizacloud) end up inlined
//    here via Bun.build's workspace resolution despite the @elizaos/* regex,
//    which is how undici reaches this bundle in the first place.
const external = [/^@elizaos\//, "undici"];

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
  await Bun.file("dist/index.js.map")
    .exists()
    .catch(() => false)
) {
  renameSync("dist/index.js.map", "dist/index.mjs.map");
}

console.log("📝 Generating TypeScript declarations...");
// wallet tsconfig has noEmit: true — override with --noEmit false, set outDir + rootDir explicitly
await $`tsc --emitDeclarationOnly --declaration --noEmit false --outDir dist --rootDir src --noCheck --skipLibCheck -p tsconfig.json`.quiet();

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
