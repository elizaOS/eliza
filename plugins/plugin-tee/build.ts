#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-tee (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-tee",
  clean: true,
  externals: "auto",
  externalsOptions: {
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
  },
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
});
