#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@google/genai", "@elizaos/core"];

async function build() {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  const nodeStart = Date.now();
  console.log("Building @elizaos/plugin-google-genai for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
  });
  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  const browserStart = Date.now();
  console.log("Building @elizaos/plugin-google-genai for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: join(distDir, "browser"),
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
  });
  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  const cjsStart = Date.now();
  console.log("Building @elizaos/plugin-google-genai for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "undici"],
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
  console.log(`CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("Generating TypeScript declarations...");
  const { $ } = await import("bun");
  try {
    await $`tsc --project tsconfig.build.json`;
  } catch (_e) {
    console.warn("TypeScript declaration generation had errors");
  }

  const nodeDir = join(distDir, "node");
  const browserDir = join(distDir, "browser");
  const cjsDir = join(distDir, "cjs");

  if (!existsSync(nodeDir)) await mkdir(nodeDir, { recursive: true });
  if (!existsSync(browserDir)) await mkdir(browserDir, { recursive: true });
  if (!existsSync(cjsDir)) await mkdir(cjsDir, { recursive: true });

  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = `export * from "./node/index";
export { default } from "./node/index";
`;
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

  const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
  const nodeAlias = `export * from "./index.node";
export { default } from "./index.node";
`;
  await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

  const browserIndexDtsPath = join(browserDir, "index.d.ts");
  const browserAlias = `export * from "./index.browser";
export { default } from "./index.browser";
`;
  await writeFile(browserIndexDtsPath, browserAlias, "utf8");

  const cjsIndexDtsPath = join(cjsDir, "index.d.ts");
  const cjsAlias = `export * from "./index.node";
export { default } from "./index.node";
`;
  await writeFile(cjsIndexDtsPath, cjsAlias, "utf8");

  console.log(`Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
  console.log(`All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
