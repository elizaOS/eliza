#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-agent-orchestrator (Node + Node CJS).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs.
 *
 * No browser build: this plugin includes Node-only services (ACP subprocess
 * sessions, workspace lifecycle, child_process spawn). Browser callers should
 * only depend on the type definitions; the package's `exports` field points the
 * browser condition at the same node bundle for resolution purposes but the
 * runtime is Node/bun.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-agent-orchestrator",
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
    {
      label: "Node (CJS)",
      entry: "index.node.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      renames: [["index.node.js", "index.node.cjs"]],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    {
      path: "index.d.ts",
      content: `export * from "./node/index";\nexport { default } from "./node/index";\n`,
    },
    {
      path: "node/index.d.ts",
      content: `export * from "./index.node";\nexport { default } from "./index.node";\n`,
    },
    {
      path: "cjs/index.d.ts",
      content: `export * from "./index.node";\nexport { default } from "./index.node";\n`,
    },
  ],
});
