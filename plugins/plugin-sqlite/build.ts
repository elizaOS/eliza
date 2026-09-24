#!/usr/bin/env bun
/** Builds the shared persistent adapter with runtime-selected native SQLite drivers. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-sqlite",
  clean: true,
  externals: [
    "@elizaos/core",
    "@elizaos/retrieval",
    "node:sqlite",
    "bun:sqlite",
    "devalue",
    "sql.js",
  ],
  targets: [
    { label: "Portable", entry: "./portable.ts", outSubdir: ".", target: "node", format: "esm" },
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
