#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-x402 (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-x402",
  externals: ["@elizaos/core", "viem", "drizzle-orm", "@solana/web3.js"],
  targets: [
    {
      label: "Node",
      entry: "./src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.dts.json",
});
