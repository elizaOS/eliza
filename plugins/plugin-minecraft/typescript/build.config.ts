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
    "node:http",
    "node:https",
    "node:crypto",
    "node:stream",
    "node:buffer",
    "node:util",
    "node:events",
    "node:url",
    "dotenv",
    "vitest",
    "zod",
    "@elizaos/core",
  ],
  naming: "[dir]/[name].[ext]",
};
