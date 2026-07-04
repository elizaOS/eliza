#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-e2b-sandbox (Node). Orchestration lives in
 * the shared driver (plugins/plugin-build.ts); this lists only what differs.
 * `e2b` is externalized (heavy vendor SDK, imported lazily at runtime).
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-e2b-sandbox",
  clean: true,
  externals: ["@elizaos/core", "e2b"],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
