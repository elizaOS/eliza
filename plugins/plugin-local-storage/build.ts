#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-local-storage (Node ESM only)
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
      naming: { entry: "index.js" },
    },
  ],
  dtsProject: "tsconfig.build.json",
});
