#!/usr/bin/env bun
import { renameSync, rmSync } from "node:fs";
import { $ } from "bun";

type PackageJson = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function externalsFromPackageJson(
  pkgJsonPath: string,
): Promise<string[]> {
  const pkg = (await Bun.file(pkgJsonPath).json()) as PackageJson;
  const deps = Object.keys(pkg.dependencies ?? {});
  const peers = Object.keys(pkg.peerDependencies ?? {});
  return [...new Set([...deps, ...peers])];
}

// Externalize anything in dependencies + peerDependencies so transitive Node-internal API users (undici, ws, etc.) aren't inlined.
// Workspace `@elizaos/*` packages are already listed in package.json, so the
// previous `/^@elizaos\//` regex is redundant once we read from package.json.
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

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
