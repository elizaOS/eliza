#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url)
);

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rm-path-recursive failed for ${target} with status ${result.status}`);
  }
}

async function build() {
  const totalStart = Date.now();
  const externalDeps = await externalsFromPackageJson("./package.json");

  console.log("Cleaning...");
  if (existsSync("dist")) rmRecursive("dist");

  const buildStart = Date.now();
  console.log("Building @elizaos/plugin-mysticism...");
  const result = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!result.success) {
    console.error(result.logs);
    throw new Error("Build failed");
  }
  console.log(`Build complete in ${((Date.now() - buildStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("Generating TypeScript declarations...");
  const { $ } = await import("bun");
  try {
    if (existsSync("tsconfig.build.json"))
      await $`tsc --project tsconfig.build.json --noCheck`.quiet();
    console.log(`Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
  } catch (_error) {
    console.warn(
      `Declaration generation had errors (${((Date.now() - dtsStart) / 1000).toFixed(2)}s)`
    );
  }

  const distDir = join(process.cwd(), "dist");
  if (!existsSync(distDir)) await mkdir(distDir, { recursive: true });
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  if (!existsSync(rootIndexDtsPath)) {
    await writeFile(
      rootIndexDtsPath,
      'export * from "./index";\nexport { default } from "./index";\n',
      "utf8"
    );
  }

  console.log(`All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
