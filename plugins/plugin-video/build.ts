#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const external = await externalsFromPackageJson("./package.json", {
  extra: ["node:*", "bun:*"],
});

console.log("🔨 Building @elizaos/plugin-video...");
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
await $`tsc --emitDeclarationOnly --declaration --declarationDir dist --noCheck -p tsconfig.json`.quiet();

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
