#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pluginDir = path.join(
  repoRoot,
  "eliza",
  "plugins",
  "plugin-agent-orchestrator",
);

const externals = [
  "node:*",
  "@elizaos/core",
  "coding-agent-adapters",
  "git-workspace-service",
  "pty-manager",
  "pty-console",
  "pty-state-capture",
  "zod",
];

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
    `[build-bundled-orchestrator-artifact] built ${result.outputs.length} file(s)`,
  );
}

main().catch((error) => {
  console.error(
    `[build-bundled-orchestrator-artifact] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
