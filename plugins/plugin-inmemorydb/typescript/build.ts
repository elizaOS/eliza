#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateDts, runBuild } from "../../../build-utils";

const PLUGIN_ROOT = resolve(dirname(import.meta.path), "..");

async function buildAll() {
  const originalCwd = process.cwd();
  process.chdir(PLUGIN_ROOT);

  try {
    const nodeOk = await runBuild({
      packageName: "@elizaos/plugin-inmemorydb",
      buildOptions: {
        entrypoints: ["typescript/index.ts"],
        outdir: "typescript/dist/node",
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
        entrypoints: ["typescript/index.ts"],
        outdir: "typescript/dist/browser",
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
    await generateDts("typescript/tsconfig.build.json", false);

    const distDir = join(PLUGIN_ROOT, "typescript", "dist");
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
      'export * from "./node/index";',
      'export { default } from "./node/index";',
      "",
    ].join("\n");
    await writeFile(rootIndexDtsPath, rootAlias, "utf8");

    const browserIndexDtsPath = join(browserDir, "index.d.ts");
    const browserAlias = [
      'export * from "./index";',
      'export { default } from "./index";',
      "",
    ].join("\n");
    await writeFile(browserIndexDtsPath, browserAlias, "utf8");

    const nodeIndexDtsPath = join(nodeDir, "index.d.ts");
    const nodeAlias = ['export * from "./index";', 'export { default } from "./index";', ""].join(
      "\n"
    );
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
