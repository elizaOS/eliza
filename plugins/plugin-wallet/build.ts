#!/usr/bin/env bun
import { copyFileSync, renameSync, rmSync } from "node:fs";
import { $ } from "bun";

// Externalize everything in `dependencies` + `peerDependencies` so transitive
// Node-internal API users (undici, ws, etc.) aren't inlined, and so workspace
// `@elizaos/*` packages stay external regardless of how Bun.build resolves
// them (string vs. workspace-relative path). This replaces the previous
// `[/^@elizaos\//, "undici"]` regex, which missed @elizaos/plugin-elizacloud
// when resolved via a relative path and thus inlined undici@8.x — whose
// `CacheStorage` constructor calls Node-internal `webidl.util.markAsUncloneable`
// (absent on Bun), crashing at top-level import.
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const external = await externalsFromPackageJson("./package.json");

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

// The runtime entry is dist/index.mjs. Keep the legacy .d.ts file for tooling
// that reads package-level "types", and also emit the NodeNext-matching .d.mts
// declaration so resolvers that pair .mjs with .d.mts do not fall back to any.
copyFileSync("dist/index.d.ts", "dist/index.d.mts");

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
