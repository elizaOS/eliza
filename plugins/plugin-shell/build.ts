#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-shell (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-shell",
  clean: true,
  externals: ["@elizaos/core", "@elizaos/shared", "cross-spawn", "zod", "@lydell/node-pty"],
  targets: [{ label: "Node", entry: "./index.ts", outSubdir: "", target: "node", format: "esm" }],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
