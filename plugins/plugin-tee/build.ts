#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${target} with status ${result.status}`,
    );
  }
}

const externalDeps = await externalsFromPackageJson("./package.json", {
  // Preserve transitive packages + bare-string node builtins the hand-list
  // relied on. Most of these are pulled in via @solana/web3.js and viem.
  extra: [
    "dotenv",
    "fs",
    "path",
    "@reflink/reflink",
    "@node-llama-cpp",
    "https",
    "http",
    "agentkeepalive",
    "safe-buffer",
    "base-x",
    "bs58",
    "borsh",
    "stream",
    "buffer",
    "undici",
    "zod",
  ],
});

async function buildPlugin() {
  console.log("Building @elizaos/plugin-tee...\n");

  if (existsSync("dist")) {
    rmRecursive("dist");
  }

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

  console.log(`Built ${buildResult.outputs.length} file(s)`);

  const tscProcess = Bun.spawn(
    ["bunx", "tsc", "-p", "tsconfig.build.json", "--noCheck"],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await tscProcess.exited;

  if (tscProcess.exitCode !== 0) {
    console.error("TypeScript declaration generation failed");
    process.exit(1);
  }

  console.log("\nBuild complete!");
}

buildPlugin().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
