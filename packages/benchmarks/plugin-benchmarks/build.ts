#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-benchmarks. Bundles the public source barrel
 * entry for Node (ESM, external sourcemap) with all @elizaos/* dependencies
 * externalized, then emits type declarations via tsconfig.build.json.
 */
import { rmSync } from "node:fs";
import { $ } from "bun";

process.chdir(import.meta.dirname);
rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: ["@elizaos/*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await $`bun x --no-install tsc -p tsconfig.build.json`;

console.log("[build] @elizaos/plugin-benchmarks built to dist/");
