#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

const external = await externalsFromPackageJson("./package.json", {
  extra: ["node:*", "bun:*"],
});

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${target} with status ${result.status}`,
    );
  }
}

console.log("🔨 Building @elizaos/plugin-video...");
const start = Date.now();

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
await $`tsc --emitDeclarationOnly --declaration --declarationDir dist --noCheck -p tsconfig.json`.quiet();

console.log(
  `✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
