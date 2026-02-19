#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const externalDeps = [
  "dotenv",
  "fs",
  "path",
  "@reflink/reflink",
  "https",
  "http",
  "agentkeepalive",
  "zod",
  "@elizaos/core",
];

async function buildPlugin() {
  console.log("Building @elizaos/plugin-planning...\n");

  if (existsSync("dist")) {
    await rm("dist", { recursive: true, force: true });
  }

  console.log("Bundling with Bun...");
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

  console.log("Generating type declarations...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await tscProcess.exited;

  if (tscProcess.exitCode !== 0) {
    console.warn("⚠️ TypeScript declaration generation had errors (e.g. getMemoryManager/Memory types); continuing.");
  }

  console.log("\nBuild complete!");
}

buildPlugin().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
