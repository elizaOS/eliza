#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-agent-orchestrator (Node + Node CJS).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs.
 *
 * This entry builds Node services. The separate build:ui command emits the
 * browser-safe /ui subpaths and view bundle without subprocess dependencies.
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) =>
  `export * from "${from}";\nexport { default } from "${from}";\n`;

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
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "node/index.d.ts", content: reexport("./index.node") },
    { path: "cjs/index.d.ts", content: reexport("./index.node") },
  ],
});
