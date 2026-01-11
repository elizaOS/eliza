#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-mcp TypeScript implementation
 * Generates ESM output and TypeScript declarations
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core", "@modelcontextprotocol/sdk", "ajv", "json5"];

async function build(): Promise<boolean> {
  const totalStart = Date.now();

  // ESM build for Node
  const esmStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-mcp for Node (ESM)...");
  const esmResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "../dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!esmResult.success) {
    console.error("ESM build errors:", esmResult.logs);
    throw new Error("ESM build failed");
  }
  console.log(`✅ ESM build complete in ${((Date.now() - esmStart) / 1000).toFixed(2)}s`);

  // CJS build for Node (CommonJS compatibility)
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-mcp for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "../dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!cjsResult.success) {
    console.error("CJS build errors:", cjsResult.logs);
    throw new Error("CJS build failed");
  }

  // Rename .js to .cjs for correct loading when package type is module
  const { rename, readdir } = await import("node:fs/promises");
  const files = await readdir("../dist/cjs");
  for (const file of files) {
    if (file.endsWith(".js")) {
      await rename(`../dist/cjs/${file}`, `../dist/cjs/${file.replace(".js", ".cjs")}`);
    }
  }
  console.log(`✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  // Ensure dist directories exist
  const distDir = join(process.cwd(), "..", "dist");
  const nodeDir = join(distDir, "node");
  if (!existsSync(nodeDir)) {
    await mkdir(nodeDir, { recursive: true });
  }

  // Create root index.d.ts alias
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = [
    'export * from "./node/index";',
    'export { default } from "./node/index";',
    "",
  ].join("\n");
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

  console.log(`🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
  return true;
}

build()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((err) => {
    console.error("Build failed:", err);
    process.exit(1);
  });
