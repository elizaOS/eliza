#!/usr/bin/env bun

import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const NODE_BUILTINS = [
  "node:fs",
  "node:path",
  "node:http",
  "node:https",
  "node:crypto",
  "node:stream",
  "node:buffer",
  "node:util",
  "node:events",
  "node:url",
] as const;

async function build(): Promise<void> {
  await $`rm -rf dist`;

  const external = await externalsFromPackageJson("./package.json", {
    extra: NODE_BUILTINS,
  });

  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    external,
    naming: "[dir]/[name].[ext]",
  });
  if (!result.success) {
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    await $`tsc --project tsconfig.build.json`;
  } catch {
    // declaration generation is best-effort
  }
}

build().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
