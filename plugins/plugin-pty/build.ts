#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-pty (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 * `@lydell/node-pty` is externalized (native module, optional dependency).
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-pty",
  clean: true,
  externals: ["@elizaos/core", "@lydell/node-pty"],
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
