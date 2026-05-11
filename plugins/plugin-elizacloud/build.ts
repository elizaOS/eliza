#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const externalDeps = [
  "@elizaos/core",
  "@elizaos/cloud-sdk",
  "@ai-sdk/openai",
  "ai",
  "js-tiktoken",
  "jose",
];

async function build() {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  // Clean dist directory
  if (existsSync(distDir)) {
    await Bun.$`rm -rf ${distDir}`;
  }

  await mkdir(distDir, { recursive: true });

  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-elizacloud for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.node.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
  });
  if (!nodeResult.success) {
    console.error(nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-elizacloud for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["src/index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: [...externalDeps, "undici"],
  });
  if (!browserResult.success) {
    console.error(browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-elizacloud for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["src/index.node.ts"],
    outdir: "dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
  });
  if (!cjsResult.success) {
    console.error(cjsResult.logs);
    throw new Error("CJS build failed");
  }
  try {
    await rename("dist/cjs/index.node.js", "dist/cjs/index.node.cjs");
  } catch (e) {
    console.warn("CJS rename step warning:", e);
  }
  console.log(`✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  const subpathStart = Date.now();
  console.log("📦 Building exported subpaths...");
  const subpathEntries = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync("."))
    .filter((entry) => {
      if (entry.includes("__tests__/") || entry.endsWith(".test.ts")) return false;
      if (entry === "src/index.node.ts" || entry === "src/index.browser.ts") return false;
      return true;
    })
    .sort();
  await Promise.all(
    Array.from(new Set(subpathEntries.map((entry) => join("dist", dirname(entry))))).map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
  const subpathResult = await Bun.build({
    entrypoints: subpathEntries,
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
    naming: {
      entry: "[dir]/[name].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  });
  if (!subpathResult.success) {
    console.error(subpathResult.logs);
    throw new Error("Subpath build failed");
  }
  if (existsSync("dist/src")) {
    await Bun.$`cp -R dist/src/. dist/ && rm -rf dist/src`;
  }
  console.log(`✅ Exported subpaths built in ${((Date.now() - subpathStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  await Bun.$`tsc --project tsconfig.build.json`;
  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  await mkdir("dist/cjs", { recursive: true });
  await writeFile(
    "dist/node/index.d.ts",
    `export * from '../index.node';
export { default } from '../index.node';
`
  );
  await writeFile(
    "dist/browser/index.d.ts",
    `export * from '../index';
export { default } from '../index';
`
  );
  await writeFile(
    "dist/cjs/index.d.ts",
    `export * from '../index.node';
export { default } from '../index.node';
`
  );
  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
