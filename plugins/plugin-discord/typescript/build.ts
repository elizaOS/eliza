#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-discord TypeScript implementation
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../../../build-utils";

async function buildAll(): Promise<boolean> {
  // Node build: Discord.js is Node-only, no browser support
  const nodeOk = await runBuild({
    packageName: "@elizaos/plugin-discord",
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
        // Discord.js and its dependencies
        "discord.js",
        "@discordjs/opus",
        "@discordjs/rest",
        "@discordjs/voice",
        // Audio/video processing
        "fluent-ffmpeg",
        "prism-media",
        "opusscript",
        "libsodium-wrappers",
        // Other externals
        "dotenv",
        "zod",
        "fast-levenshtein",
        "get-func-name",
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
