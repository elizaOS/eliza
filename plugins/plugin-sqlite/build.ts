#!/usr/bin/env bun
/** Builds the shared persistent adapter with runtime-selected native SQLite drivers. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-sqlite",
  clean: true,
  externals: [
    "@elizaos/core",
    "@elizaos/plugin-inmemorydb",
    "node:sqlite",
    "bun:sqlite",
    "devalue",
  ],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsTolerant: false,
});
