#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-tee",
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
