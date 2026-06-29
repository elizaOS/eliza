#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-twitch (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-twitch",
  externals: ["@elizaos/core", "@twurple/auth", "@twurple/chat"],
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
