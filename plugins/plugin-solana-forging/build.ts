#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-solana-forging",
  externals: ["@elizaos/core"],
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
