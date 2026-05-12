#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-openai TypeScript package
 *
 * Produces:
 * - dist/node/index.node.js (ESM for Node.js)
 * - dist/browser/index.browser.js (ESM for browsers)
 * - dist/cjs/index.node.cjs (CommonJS for Node.js)
 * - dist/*.d.ts (TypeScript declarations)
 */

const externalDeps = ["@elizaos/core", "@ai-sdk/openai", "ai", "js-tiktoken"];

async function build(): Promise<void> {
  const totalStart = Date.now();

  // Node ESM build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-openai for Node (ESM)...");

  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!nodeResult.success) {
    console.error("Node ESM build failed:", nodeResult.logs);
    throw new Error("Node ESM build failed");
  }

  console.log(`✅ Node ESM build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  // Browser ESM build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-openai for Browser...");

  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: externalDeps,
  });

  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }

  console.log(`✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  // Node CJS build

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");

  const { mkdir, writeFile } = await import("node:fs/promises");

  await Bun.$`tsc --project tsconfig.build.json`;

  // Create output directories
  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  // Create re-export declaration files for each entry point
  const reexportDeclaration = `export * from '../index';
export { default } from '../index';
`;

  await writeFile("dist/node/index.d.ts", reexportDeclaration);
  await writeFile("dist/browser/index.d.ts", reexportDeclaration);
  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(2);
  console.log(`🎉 All builds finished in ${totalTime}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
