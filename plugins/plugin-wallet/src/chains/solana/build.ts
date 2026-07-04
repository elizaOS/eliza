#!/usr/bin/env bun
/**
 * Build script for the Solana chain subpackage: bundles `index.ts` with
 * `Bun.build`, externalizing every declared dependency from `package.json`,
 * then runs `tsc --noCheck` to emit type declarations.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../../../../packages/scripts/rm-path-recursive.mjs", import.meta.url)
);
const PACKAGE_JSON = fileURLToPath(new URL("../../../package.json", import.meta.url));

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rm-path-recursive failed for ${target} with status ${result.status}`);
  }
}

async function build(): Promise<void> {
  const totalStart = Date.now();

  console.log("🔨 Building @elizaos/plugin-wallet solana chain...\n");

  if (existsSync("dist")) {
    rmRecursive("dist");
  }

  const pkg = await Bun.file(PACKAGE_JSON).json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  console.log("📦 Bundling with Bun...");
  const esmResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!esmResult.success) {
    console.error("Build failed:");
    for (const log of esmResult.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${esmResult.outputs.length} file(s)`);

  console.log("📝 Generating TypeScript declarations...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json", "--noCheck"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await tscProcess.exited;

  // noEmitOnError: false in tsconfig.build.json allows declarations to be generated
  // even if there are type errors (which can happen with complex monorepo resolution)
  if (tscProcess.exitCode !== 0) {
    console.warn("⚠️ TypeScript declaration generation had warnings (non-blocking)");
  }

  console.log(`\n✅ Build complete in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
