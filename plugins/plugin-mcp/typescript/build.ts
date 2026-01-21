#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-mcp (TypeScript package).
 *
 * Outputs:
 * - ESM (Node): dist/node/index.js
 * - CJS (Node): dist/cjs/index.cjs
 * - Types: dist/index.d.ts + dist/node/index.d.ts + dist/cjs/index.d.ts
 */

const externalDeps = ["@elizaos/core", "@modelcontextprotocol/sdk", "ajv", "json5"];

async function build(): Promise<void> {
  const totalStart = Date.now();

  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-mcp for Node (ESM)...");
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.ts"],
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

  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-mcp for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!cjsResult.success) {
    console.error("Node CJS build failed:", cjsResult.logs);
    throw new Error("Node CJS build failed");
  }

  const { rename, access, mkdir, writeFile } = await import("node:fs/promises");
  const { $ } = await import("bun");

  // Rename Bun's CJS output to .cjs to be loadable under "type": "module".
  await access("dist/cjs/index.js");
  await rename("dist/cjs/index.js", "dist/cjs/index.cjs");

  console.log(`✅ Node CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  await $`tsc --project tsconfig.build.json`;

  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/cjs", { recursive: true });

  const rootReexport = `export * from "./node/index";
export { default } from "./node/index";
`;
  const cjsReexport = `export * from "../node/index";
export { default } from "../node/index";
`;

  await writeFile("dist/index.d.ts", rootReexport);
  await writeFile("dist/cjs/index.d.ts", cjsReexport);

  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
