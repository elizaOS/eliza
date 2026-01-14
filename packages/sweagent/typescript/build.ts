#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

async function buildJs(): Promise<void> {
  // Root entrypoint
  const root = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    minify: false,
  });
  if (!root.success) {
    for (const log of root.logs) console.error(log);
    throw new Error("bun build failed (src/index.ts)");
  }

  // CLI entrypoint (keep path: dist/run/cli.js)
  await mkdir(join("dist", "run"), { recursive: true });
  const cli = await Bun.build({
    entrypoints: ["src/run/cli.ts"],
    outdir: join("dist", "run"),
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    minify: false,
  });
  if (!cli.success) {
    for (const log of cli.logs) console.error(log);
    throw new Error("bun build failed (src/run/cli.ts)");
  }
}

async function buildTypes(): Promise<void> {
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.json --emitDeclarationOnly`;
}

async function main(): Promise<void> {
  await mkdir("dist", { recursive: true });
  await buildJs();
  await buildTypes();
}

await main();
