#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-farcaster (Node + Browser)
 *
 * This script builds the TypeScript source for both Node.js and browser environments.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core", "@neynar/nodejs-sdk", "lru-cache", "zod"];

async function build() {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  await rm(distDir, { recursive: true, force: true });

  // Node build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-farcaster for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  // Browser build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-farcaster for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: join(distDir, "browser"),
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  // Node CJS build
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-farcaster for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!cjsResult.success) {
    console.error("CJS build failed:", cjsResult.logs);
    throw new Error("CJS build failed");
  }
  try {
    const { rename } = await import("node:fs/promises");
    await rename(join(distDir, "cjs", "index.node.js"), join(distDir, "cjs", "index.node.cjs"));
  } catch (e) {
    console.warn("CJS rename step warning:", e);
  }
  console.log(`✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;

  const nodeDir = join(distDir, "node");
  const browserDir = join(distDir, "browser");
  const cjsDir = join(distDir, "cjs");

  await mkdir(nodeDir, { recursive: true });
  await mkdir(browserDir, { recursive: true });
  await mkdir(cjsDir, { recursive: true });

  // Package exports point types at dist/{node,browser,cjs}/index.d.ts; declarations
  // for entry graphs live at dist/index.{node,browser}.d.ts from `tsc`.
  const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
  const nodeAlias = `export * from "../index.node";
export { default } from "../index.node";
`;
  await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");
  // Adjacent to index.node.js: some TS (bundler + dynamic import) only look for
  // index.node.d.ts here, not package.json "types".
  await writeFile(join(nodeDir, "index.node.d.ts"), nodeAlias, "utf8");

  const browserIndexDtsPath = join(browserDir, "index.d.ts");
  const browserAlias = `export * from "../index.browser";
export { default } from "../index.browser";
`;
  await writeFile(browserIndexDtsPath, browserAlias, "utf8");

  const cjsIndexDtsPath = join(cjsDir, "index.d.ts");
  const cjsAlias = `export * from "../index.node";
export { default } from "../index.node";
`;
  await writeFile(cjsIndexDtsPath, cjsAlias, "utf8");

  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`🎉 All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
