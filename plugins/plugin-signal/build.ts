#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-signal (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-signal",
  externals: ["@elizaos/core", "zod"],
  targets: [
    { label: "Node", entry: "./src/index.ts", outSubdir: "", target: "node", format: "esm" },
  ],
  dtsProject: "tsconfig.build.json",
});
