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

export function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rm-path-recursive failed for ${target} with status ${result.status}`);
  }
}

export async function buildSolanaChain(
  options: {
    build?: typeof Bun.build;
    spawn?: typeof Bun.spawn;
    packageJson?: () => Promise<{
      dependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    }>;
    remove?: typeof rmRecursive;
    exists?: typeof existsSync;
  } = {}
): Promise<number> {
  const totalStart = Date.now();
  const exists = options.exists ?? existsSync;

  console.log("🔨 Building @elizaos/plugin-wallet solana chain...\n");

  if (exists("dist")) {
    (options.remove ?? rmRecursive)("dist");
  }

  const pkg = await (options.packageJson ?? (() => Bun.file(PACKAGE_JSON).json()))();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  console.log("📦 Bundling with Bun...");
  const esmResult = await (options.build ?? Bun.build)({
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
    return 1;
  }

  console.log(`✅ Built ${esmResult.outputs.length} file(s)`);

  console.log("📝 Generating TypeScript declarations...");
  const tscProcess = (options.spawn ?? Bun.spawn)(
    ["bunx", "tsc6", "-p", "tsconfig.build.json", "--noCheck"],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  await tscProcess.exited;

  // noEmitOnError: false in tsconfig.build.json allows declarations to be generated
  // even if there are type errors (which can happen with complex monorepo resolution)
  if (tscProcess.exitCode !== 0) {
    console.warn("⚠️ TypeScript declaration generation had warnings (non-blocking)");
  }

  console.log(`\n✅ Build complete in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
  return 0;
}

if (import.meta.main) {
  const exitCode = await buildSolanaChain().catch((err) => {
    console.error("Build failed:", err);
    return 1;
  });
  if (exitCode !== 0) process.exit(exitCode);
}
