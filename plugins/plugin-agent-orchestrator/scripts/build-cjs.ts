#!/usr/bin/env bun
/** Build the CommonJS target with a fresh Bun resolver, preserving ESM output. */
import { buildPlugin } from "../../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-agent-orchestrator",
  externals: "auto",
  clean: false,
  targets: [
    {
      label: "Node (CJS)",
      entry: "index.node.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      renames: [["index.node.js", "index.node.cjs"]],
    },
  ],
});
