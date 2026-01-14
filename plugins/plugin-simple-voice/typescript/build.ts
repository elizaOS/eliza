#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "dist");

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });

console.log("Building @elizaos/plugin-simple-voice...");
const result = await build({
  entrypoints: [join(__dirname, "index.ts")],
  outdir: DIST,
  target: "browser",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "sam-js"],
  naming: {
    entry: "index.js",
  },
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

console.log("Generating TypeScript declarations...");
const { $ } = await import("bun");
const tscResult = await $`tsc --project tsconfig.build.json --emitDeclarationOnly`.nothrow();

if (tscResult.exitCode !== 0) {
  console.error("TypeScript declaration generation failed");
  process.exit(1);
}

console.log("Build complete!");
