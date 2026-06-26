#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

rmSync("dist", { recursive: true, force: true });

const external = await externalsFromPackageJson("./package.json");

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external,
});
if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

const { $ } = await import("bun");
await $`tsc --emitDeclarationOnly --noCheck -p tsconfig.build.json`;
await $`node ../../packages/scripts/rewrite-dist-relative-imports-node-esm.mjs`;

console.log("Build complete: @elizaos/plugin-ainex");
