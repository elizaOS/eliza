#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-linear (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-linear",
  clean: true,
  externals: "auto",
  externalsOptions: {
    // Preserve transitive externals the hand-maintained list relied on.
    // These show up via @linear/sdk + agentkeepalive's transitive graph;
    // keep them externalized to avoid inlining Node-builtin API users.
    extra: ["dotenv", "fs", "path", "@reflink/reflink", "https", "http", "agentkeepalive", "zod"],
  },
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
});
