#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const pluginDir = path.join(
  repoRoot,
  "plugins",
  "plugin-agent-skills",
  "typescript",
);

const externals = ["node:*", "@elizaos/core", "fflate"];

async function main() {
  process.chdir(pluginDir);

  if (existsSync("dist")) {
    await rm("dist", { recursive: true, force: true });
  }

  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    format: "esm",
    sourcemap: "linked",
    minify: false,
    external: externals,
    naming: {
      entry: "[dir]/[name].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(
    `[build-bundled-agent-skills-artifact] built ${result.outputs.length} file(s)`,
  );
}

main().catch((error) => {
  console.error(
    `[build-bundled-agent-skills-artifact] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
