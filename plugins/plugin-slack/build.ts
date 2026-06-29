#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-slack (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-slack",
  externals: ["@elizaos/core", "@slack/bolt", "@slack/web-api", "zod"],
  targets: [
    {
      label: "Node",
      entry: "./src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
});
