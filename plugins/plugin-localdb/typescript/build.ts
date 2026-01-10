#!/usr/bin/env bun

/**
 * Dual build script for @elizaos/plugin-localdb (Node + Browser)
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../../build-utils";

async function buildAll() {
  // Node build (server): File-based storage
  const nodeOk = await runBuild({
    packageName: "@elizaos/plugin-localdb",
    buildOptions: {
      entrypoints: ["typescript/index.node.ts"],
      outdir: "dist/node",
      target: "node",
      format: "esm",
      external: [
        "@elizaos/core",
        "fs",
        "path",
        "node:fs",
        "node:fs/promises",
        "node:path",
      ],
      sourcemap: true,
      minify: false,
      generateDts: true,
    },
  });

  if (!nodeOk) return false;

  // Browser build (client): localStorage-based storage
  const browserOk = await runBuild({
    packageName: "@elizaos/plugin-localdb",
    buildOptions: {
      entrypoints: ["typescript/index.browser.ts"],
      outdir: "dist/browser",
      target: "browser",
      format: "esm",
      external: ["@elizaos/core"],
      sourcemap: true,
      minify: false,
      generateDts: true,
    },
  });

  if (!browserOk) return false;

  // Ensure declaration entry points are present for consumers
  const distDir = join(process.cwd(), "dist");
  const browserDir = join(distDir, "browser");
  const nodeDir = join(distDir, "node");
  
  if (!existsSync(browserDir)) {
    await mkdir(browserDir, { recursive: true });
  }
  if (!existsSync(nodeDir)) {
    await mkdir(nodeDir, { recursive: true });
  }

  // Root types alias to node by default for server editors
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = [
    'export * from "./node/index";',
    'export { default } from "./node/index";',
    "",
  ].join("\n");
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

  // Browser alias
  const browserIndexDtsPath = join(browserDir, "index.d.ts");
  const browserAlias = [
    'export * from "./index.browser";',
    'export { default } from "./index.browser";',
    "",
  ].join("\n");
  await writeFile(browserIndexDtsPath, browserAlias, "utf8");

  // Node alias
  const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
  const nodeAlias = [
    'export * from "./index.node";',
    'export { default } from "./index.node";',
    "",
  ].join("\n");
  await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

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
