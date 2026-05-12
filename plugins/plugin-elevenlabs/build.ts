#!/usr/bin/env bun

/**
 * Dual build script for @elizaos/plugin-elevenlabs (Node + Browser)
 */

import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";

const externalDeps = ["@elizaos/core"];

async function build() {
  const totalStart = Date.now();

  // Node build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-elevenlabs for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.node.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!nodeResult.success) {
    console.error(nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(
    `✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`,
  );

  // Browser build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-elevenlabs for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["src/index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: [...externalDeps, "@elevenlabs/elevenlabs-js"],
  });
  if (!browserResult.success) {
    console.error(browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(
    `✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`,
  );

  // Node CJS build
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-elevenlabs for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["src/index.node.ts"],
    outdir: "dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!cjsResult.success) {
    console.error(cjsResult.logs);
    throw new Error("CJS build failed");
  }
  await rename("dist/cjs/index.node.js", "dist/cjs/index.node.cjs");
  console.log(
    `✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`,
  );

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const tsc = spawnSync("bunx", ["tsc", "--project", "tsconfig.build.json"], {
    stdio: "inherit",
    shell: false,
  });
  if (tsc.status !== 0) {
    throw new Error("TypeScript declaration emit failed");
  }

  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  await mkdir("dist/cjs", { recursive: true });

  const nodeTypes = `export * from "../index.node";
export { default } from "../index.node";
`;
  const browserTypes = `export * from "../index.browser";
export { default } from "../index.browser";
`;

  await writeFile("dist/node/index.d.ts", nodeTypes);
  await writeFile("dist/browser/index.d.ts", browserTypes);
  await writeFile("dist/cjs/index.d.ts", nodeTypes);

  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`,
  );

  console.log(
    `🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
