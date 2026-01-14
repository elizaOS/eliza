#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-bluesky (Node + Browser)
 *
 * This package is published from plugins/plugin-bluesky/typescript, so all outputs
 * must be written under ./dist (NOT ../dist).
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = [
  "@elizaos/core",
  "@atproto/api",
  "@atproto/identity",
  "@atproto/lexicon",
  "@atproto/syntax",
  "@atproto/xrpc",
  "lru-cache",
  "zod",
] as const;

async function build(): Promise<void> {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  // Node build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-bluesky for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  // Browser build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-bluesky for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: join(distDir, "browser"),
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  // Node CJS build
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-bluesky for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
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

  // Ensure directories exist
  const nodeDir = join(distDir, "node");
  const browserDir = join(distDir, "browser");
  const cjsDir = join(distDir, "cjs");

  if (!existsSync(nodeDir)) await mkdir(nodeDir, { recursive: true });
  if (!existsSync(browserDir)) await mkdir(browserDir, { recursive: true });
  if (!existsSync(cjsDir)) await mkdir(cjsDir, { recursive: true });

  // Root types alias to node by default
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = `export * from "./node/index";
export { default } from "./node/index";
`;
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

  // Node alias
  const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
  const nodeAlias = `export * from "./index.node";
export { default } from "./index.node";
`;
  await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

  // Browser alias
  const browserIndexDtsPath = join(browserDir, "index.d.ts");
  const browserAlias = `export * from "./index.browser";
export { default } from "./index.browser";
`;
  await writeFile(browserIndexDtsPath, browserAlias, "utf8");

  // CJS alias
  const cjsIndexDtsPath = join(cjsDir, "index.d.ts");
  const cjsAlias = `export * from "./index.node";
export { default } from "./index.node";
`;
  await writeFile(cjsIndexDtsPath, cjsAlias, "utf8");

  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
  console.log(`🎉 All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
