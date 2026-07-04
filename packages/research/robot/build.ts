#!/usr/bin/env bun
/**
 * Bun build entrypoint for the thin TypeScript surface of @elizaos/robot.
 *
 * Clears generated output, bundles the TS exports, emits declarations, and
 * rewrites relative imports while the Python robotics stack remains unbundled.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { externalsFromPackageJson } from "../../../plugins/plugin-build-externals.ts";

const rmRecursiveScript = join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "rm-path-recursive.mjs",
);

function rmRecursive(targetPath: string) {
  const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to remove generated Robot build output ${targetPath}`,
    );
  }
}

rmRecursive("dist");

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
await $`node ../../scripts/rewrite-dist-relative-imports-node-esm.mjs`;

console.log("Build complete: @elizaos/robot");
