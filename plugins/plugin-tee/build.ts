#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

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
    await rm("dist", { recursive: true, force: true });
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

  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
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
