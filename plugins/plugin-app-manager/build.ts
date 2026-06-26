#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

const external = [
  "@elizaos/core",
  "@elizaos/agent",
  "@elizaos/plugin-registry",
  "@elizaos/shared",
  "dotenv",
  "node:*",
  "bun:*",
];

console.log("🔨 Building @elizaos/plugin-app-manager...");
const start = Date.now();

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmRecursive("dist");

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external,
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("📝 Generating TypeScript declarations...");
// Override noEmit/rootDir so declarations land directly in dist/
// allowImportingTsExtensions in tsconfig forces noEmit:true, so we override with --noEmit false
await $`tsc --emitDeclarationOnly --declaration --noEmit false --declarationDir dist --rootDir src --noCheck --skipLibCheck -p tsconfig.json`.quiet();
await $`node ../../packages/scripts/rewrite-dist-relative-imports-node-esm.mjs`.quiet();

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
