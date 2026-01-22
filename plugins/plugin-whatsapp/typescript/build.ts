#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-whatsapp TypeScript implementation
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../../../build-utils";

async function buildAll(): Promise<boolean> {
  const nodeOk = await runBuild({
    packageName: "@elizaos/plugin-whatsapp",
    buildOptions: {
      entrypoints: ["index.ts"],
      outdir: "../dist",
      target: "node",
      format: "esm",
      external: [
        // Node builtins
        "fs",
        "path",
        "os",
        "http",
        "https",
        // Core dependency
        "@elizaos/core",
        // Other externals
        "axios",
      ],
      sourcemap: true,
      minify: false,
      generateDts: true,
    },
  });

  if (!nodeOk) return false;

  // Ensure dist directory exists and create proper declaration entry points
  const distDir = join(process.cwd(), "dist");
  if (!existsSync(distDir)) {
    await mkdir(distDir, { recursive: true });
  }

  // Root types alias
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const rootAlias = ['export * from "./index";', 'export { default } from "./index";', ""].join(
    "\n"
  );
  await writeFile(rootIndexDtsPath, rootAlias, "utf8");

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
