#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-matrix (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-matrix",
  externals: ["@elizaos/core", "matrix-js-sdk"],
  targets: [
    { label: "Node", entry: "./src/index.ts", outSubdir: "", target: "node", format: "esm" },
  ],
  dtsProject: "tsconfig.json",
  dtsEmitDeclarationOnly: true,
});
