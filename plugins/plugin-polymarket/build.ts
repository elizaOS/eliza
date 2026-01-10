#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-polymarket
 *
 * Builds the TypeScript implementation for Node.js environments.
 * For multi-language builds (Rust, Python), see respective folders.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function runBuild(): Promise<boolean> {
  console.log("Building @elizaos/plugin-polymarket...");

  const distDir = join(process.cwd(), "dist");

  // Clean dist directory
  if (existsSync(distDir)) {
    await Bun.$`rm -rf ${distDir}`;
  }

  await mkdir(distDir, { recursive: true });

  // Build the TypeScript code
  const result = await Bun.build({
    entrypoints: ["typescript/index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [
      // Core dependencies
      "@elizaos/core",
      "@elizaos/plugin-evm",
      // Node built-ins
      "dotenv",
      "fs",
      "path",
      "node:path",
      "node:fs",
      // External packages that should not be bundled
      "viem",
      "viem/accounts",
      "viem/chains",
      "@polymarket/clob-client",
      "ws",
      // Common externals
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

  // Generate TypeScript declarations using tsc
  console.log("Generating TypeScript declarations...");
  const tscResult = await Bun.$`cd ${process.cwd()} && bun x tsc -p tsconfig.build.json`.quiet().nothrow();

  if (tscResult.exitCode !== 0) {
    console.warn("Warning: TypeScript declaration generation had issues:");
    console.warn(tscResult.stderr.toString());
  }

  // Create index.d.ts alias if needed
  const indexDtsPath = join(distDir, "index.d.ts");
  if (!existsSync(indexDtsPath)) {
    await writeFile(
      indexDtsPath,
      `export * from "./typescript/index";
export { default } from "./typescript/index";
`,
      "utf8"
    );
  }

  console.log("Build complete!");
  return true;
}

runBuild()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });

