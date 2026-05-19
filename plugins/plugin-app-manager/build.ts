#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { $ } from "bun";

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

rmSync("dist", { recursive: true, force: true });

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

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
