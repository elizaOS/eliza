#!/usr/bin/env bun
/**
 * Build script for the EVM chain subpackage: bundles `index.ts` with
 * `Bun.build` (externalizing `@elizaos/core` and the on-chain SDK deps),
 * then runs `tsc --noCheck` to emit type declarations, writing a fallback
 * `index.d.ts` barrel if `tsc` doesn't produce one.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rmPathRecursive = fileURLToPath(
  new URL("../../../../../packages/scripts/rm-path-recursive.mjs", import.meta.url)
);

export async function runBuild(
  options: {
    build?: typeof Bun.build;
    emitDeclarations?: () => Promise<{ exitCode: number; stderr: Uint8Array }>;
    exists?: typeof existsSync;
    remove?: () => Promise<unknown>;
  } = {}
): Promise<boolean> {
  console.log("Building @elizaos/plugin-wallet evm chain...");

  const distDir = join(process.cwd(), "dist");
  const exists = options.exists ?? existsSync;

  if (exists(distDir)) {
    await (options.remove ?? (() => Bun.$`node ${rmPathRecursive} ${distDir}`))();
  }

  await mkdir(distDir, { recursive: true });

  const result = await (options.build ?? Bun.build)({
    entrypoints: ["./index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [
      "@elizaos/core",
      "dotenv",
      "fs",
      "path",
      "node:path",
      "node:fs",
      "node:os",
      "viem",
      "viem/accounts",
      "viem/chains",
      "@lifi/sdk",
      "@lifi/types",
      "@lifi/data-types",
      "zod",
      "https",
      "http",
      "agentkeepalive",
      "@reflink/reflink",
    ],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    return false;
  }

  console.log(`Build successful: ${result.outputs.length} files generated`);

  console.log("Generating TypeScript declarations...");
  const tscResult = await (
    options.emitDeclarations ??
    (() =>
      Bun.$`cd ${process.cwd()} && bun x tsc6 -p tsconfig.build.json --noCheck`.quiet().nothrow())
  )();

  if (tscResult.exitCode !== 0) {
    console.warn("Warning: TypeScript declaration generation had issues:");
    console.warn(tscResult.stderr.toString());
  }

  const indexDtsPath = join(distDir, "index.d.ts");
  if (!exists(indexDtsPath)) {
    await writeFile(
      indexDtsPath,
      `export * from "./index";
export { default } from "./index";
`,
      "utf8"
    );
  }

  console.log("Build complete!");
  return true;
}

if (import.meta.main) {
  runBuild()
    .then((ok) => {
      if (!ok) process.exit(1);
    })
    .catch((error) => {
      console.error("Build script error:", error);
      process.exit(1);
    });
}
