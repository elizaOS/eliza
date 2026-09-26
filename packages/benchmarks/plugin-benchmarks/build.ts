#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-benchmarks. Bundles the single `index.ts`
 * entry for Node (ESM, external sourcemap) with all @elizaos/* dependencies
 * externalized, then emits type declarations via tsconfig.build.json.
 */
import { rmSync } from "node:fs";
import { $ } from "bun";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["index.ts"],
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

// error-policy:J6 declaration emit is best-effort; the JS bundle is the artifact
const tsc = await $`bunx tsc -p tsconfig.build.json`.nothrow();
if (tsc.exitCode !== 0) {
  console.warn("[build] declaration emit failed (tolerated)");
}

console.log("[build] @elizaos/plugin-benchmarks built to dist/");
