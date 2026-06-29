#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-cloud-apps (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-cloud-apps",
  externals: ["@elizaos/core", "@elizaos/cloud-sdk"],
  targets: [
    {
      label: "Node",
      entry: "./src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.json",
  dtsEmitDeclarationOnly: true,
});
