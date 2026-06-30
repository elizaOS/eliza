#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-local-storage (Node ESM only).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts);
 * this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-local-storage",
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "external",
      minify: false,
      naming: { entry: "index.js" },
    },
  ],
  dtsProject: "tsconfig.build.json",
});
