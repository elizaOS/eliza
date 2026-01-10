#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-bootstrap using standardized build utilities
 * Builds from typescript/ directory to dist/
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../../build-utils";

async function buildAll() {
  // Build the TypeScript source
  // Note: generateDts is disabled temporarily due to type issues inherited from @elizaos/core
  // TODO: Re-enable once core types are strictly typed
  const ok = await runBuild({
    packageName: "@elizaos/plugin-bootstrap",
    buildOptions: {
      entrypoints: ["typescript/index.ts"],
      outdir: "dist",
      target: "node",
      format: "esm",
      external: [
        "dotenv",
        "fs",
        "path",
        "@reflink/reflink",
        "agentkeepalive",
        "zod",
        "@elizaos/core",
        "@elizaos/plugin-sql",
      ],
      sourcemap: true,
      minify: false,
      generateDts: false,
    },
  });

  if (!ok) return false;

  // Ensure dist directory exists
  const distDir = join(process.cwd(), "dist");
  if (!existsSync(distDir)) {
    await mkdir(distDir, { recursive: true });
  }

  // Create a stub index.d.ts that exports the plugin
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  const stubDeclaration = `/**
 * @elizaos/plugin-bootstrap - Agent bootstrap with basic actions, providers, evaluators and services
 * @packageDocumentation
 */

import type { Plugin } from "@elizaos/core";

/** Bootstrap plugin providing core agent functionality */
export declare const bootstrapPlugin: Plugin;
export default bootstrapPlugin;

// Re-export all action types
export * from "../typescript/actions/index";
export * from "../typescript/providers/index";
export * from "../typescript/evaluators/index";
export * from "../typescript/services/index";
`;
  await writeFile(rootIndexDtsPath, stubDeclaration, "utf8");

  return true;
}

// Execute the build
buildAll()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
