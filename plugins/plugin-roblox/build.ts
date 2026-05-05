#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core", "zod"];

async function build() {
  const distDir = join(process.cwd(), "dist");

  if (!existsSync(distDir)) {
    await mkdir(distDir, { recursive: true });
  }

  const nodeResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!nodeResult.success) {
    console.error("Build failed:", nodeResult.logs);
    throw new Error("Build failed");
  }

  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
