#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const ROOT = resolve(dirname(import.meta.path));
const DIST = join(ROOT, "dist");
const RM_RECURSIVE_SCRIPT = join(ROOT, "..", "..", "packages", "scripts", "rm-path-recursive.mjs");

function rmRecursive(targetPath: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`failed to remove generated plugin-linear build output ${targetPath}`);
  }
}

const externalDeps = await externalsFromPackageJson("./package.json", {
  // Preserve transitive externals the hand-maintained list relied on.
  // These show up via @linear/sdk + agentkeepalive's transitive graph;
  // keep them externalized to avoid inlining Node-builtin API users.
  extra: ["dotenv", "fs", "path", "@reflink/reflink", "https", "http", "agentkeepalive", "zod"],
});

async function buildPlugin() {
  console.log("🔨 Building @elizaos/plugin-linear...\n");

  rmRecursive(DIST);

  console.log("📦 Bundling with Bun...");
  const buildResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!buildResult.success) {
    console.error("Build failed:");
    for (const log of buildResult.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${buildResult.outputs.length} file(s)`);

  console.log("📝 Generating type declarations...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json", "--noCheck"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await tscProcess.exited;

  if (tscProcess.exitCode !== 0) {
    console.error("TypeScript declaration generation failed");
    process.exit(1);
  }

  console.log("\n✅ Build complete!");
}

buildPlugin().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
