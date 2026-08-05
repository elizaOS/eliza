#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-dflow-trade",
  externals: ["@elizaos/core", "@solana/web3.js", "bs58"],
  targets: [
    {
      label: "Node (ESM)",
      entry: "./src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      splitting: false,
    },
  ],
  dtsProject: "tsconfig.json",
  dtsEmitDeclarationOnly: true,
});
