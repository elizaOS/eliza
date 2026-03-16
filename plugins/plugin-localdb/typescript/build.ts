#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(process.cwd(), "dist");
const browserDir = join(distDir, "browser");
const nodeDir = join(distDir, "node");

async function buildAll() {
  console.log("🔨 Building @elizaos/plugin-localdb...\n");

  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }
  await mkdir(browserDir, { recursive: true });
  await mkdir(nodeDir, { recursive: true });

  console.log("📦 Building Node ESM...");
  const nodeResult = await build({
    entrypoints: ["./index.node.ts"],
    outdir: nodeDir,
    target: "node",
    format: "esm",
    sourcemap: "linked",
    minify: false,
    external: ["@elizaos/core", "fs", "path", "node:fs", "node:fs/promises", "node:path"],
    naming: "[name].js",
  });

  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    return false;
  }
  console.log("✅ Node build complete");

  console.log("🌐 Building Browser ESM...");
  const browserResult = await build({
    entrypoints: ["./index.browser.ts"],
    outdir: browserDir,
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    minify: false,
    external: ["@elizaos/core"],
    naming: "[name].js",
  });

  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    return false;
  }
  console.log("✅ Browser build complete");

  console.log("📝 Generating type declarations...");
  const tscBrowser = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
  });
  await tscBrowser.exited;
  if (tscBrowser.exitCode !== 0) {
    console.error("TypeScript declaration generation failed");
    return false;
  }

  const tscNode = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.node.json"], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
  });
  await tscNode.exited;
  if (tscNode.exitCode !== 0) {
    console.error("TypeScript node declaration generation failed");
    return false;
  }

  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = [
    'export * from "./node/index";',
    'export { default } from "./node/index";',
    "",
  ].join("\n");
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

  const browserIndexDtsPath = join(browserDir, "index.d.ts");
  const browserAlias = [
    'export * from "./index.browser";',
    'export { default } from "./index.browser";',
    "",
  ].join("\n");
  await writeFile(browserIndexDtsPath, browserAlias, "utf8");

  const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
  const nodeAlias = [
    'export * from "./index.node";',
    'export { default } from "./index.node";',
    "",
  ].join("\n");
  await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

  console.log("\n✅ Build complete!");
  return true;
}

buildAll()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
