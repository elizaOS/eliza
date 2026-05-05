#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateDts, runBuild } from "../../packages/core/build";

const PLUGIN_ROOT = dirname(import.meta.path);

async function buildAll() {
  const originalCwd = process.cwd();
  process.chdir(PLUGIN_ROOT);

  try {
    const nodeOk = await runBuild({
      packageName: "@elizaos/plugin-inmemorydb",
      buildOptions: {
        entrypoints: ["index.ts"],
        outdir: "dist/node",
        target: "node",
        format: "esm",
        external: ["@elizaos/core"],
        sourcemap: true,
        minify: false,
        generateDts: false,
      },
    });

    if (!nodeOk) return false;

    const browserOk = await runBuild({
      packageName: "@elizaos/plugin-inmemorydb",
      buildOptions: {
        entrypoints: ["index.browser.ts"],
        outdir: "dist/browser",
        target: "browser",
        format: "esm",
        external: ["@elizaos/core"],
        sourcemap: true,
        minify: false,
        generateDts: false,
      },
    });

    if (!browserOk) return false;

    console.log("📝 Generating type declarations...");
    await generateDts("tsconfig.build.json", false);

    const distDir = join(PLUGIN_ROOT, "dist");
    const browserDir = join(distDir, "browser");
    const nodeDir = join(distDir, "node");

    if (!existsSync(browserDir)) {
      await mkdir(browserDir, { recursive: true });
    }
    if (!existsSync(nodeDir)) {
      await mkdir(nodeDir, { recursive: true });
    }

    const rootIndexDtsPath = join(distDir, "index.d.ts");
    const rootAlias = [
      'export * from "./browser/index";',
      'export { default } from "./browser/index";',
      "",
    ].join("\n");
    await writeFile(rootIndexDtsPath, rootAlias, "utf8");

    const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
    const nodeAlias = [
      'export * from "../browser/index";',
      'export { default } from "../browser/index";',
      "",
    ].join("\n");
    await writeFile(nodeIndexDtsPath, nodeAlias, "utf8");

    return true;
  } finally {
    process.chdir(originalCwd);
  }
}

buildAll()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
