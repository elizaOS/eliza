#!/usr/bin/env bun
/** Supports app-core build, packaging, or development orchestration for build bundled orchestrator artifact mjs. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const pluginDir = path.join(repoRoot, "plugins", "plugin-agent-orchestrator");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
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

function removeGeneratedDist() {
  if (!existsSync("dist")) {
    return;
  }

  const result = spawnSync("node", [cleanupHelperScript, "dist"], {
    cwd: pluginDir,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `cleanup helper failed for ${path.join(pluginDir, "dist")}${output ? `:\n${output}` : ""}`,
    );
  }
}

async function main() {
  process.chdir(pluginDir);

  removeGeneratedDist();

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
