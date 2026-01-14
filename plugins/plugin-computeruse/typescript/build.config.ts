import type { BuildConfig } from "bun";

export const buildConfig: BuildConfig = {
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  external: [
    "node:fs",
    "node:path",
    "node:os",
    "node:child_process",
    "vitest",
    "dotenv",
    "zod",
    "@elizaos/core",
    "@elizaos/computeruse",
    "@modelcontextprotocol/sdk",
  ],
  naming: "[dir]/[name].[ext]",
};

