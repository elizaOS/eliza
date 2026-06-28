#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-edge-tts (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) => `export * from '${from}';\nexport { default } from '${from}';\n`;

await buildPlugin({
  name: "@elizaos/plugin-edge-tts",
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      naming: { entry: "index.node.js" },
    },
    {
      label: "Browser",
      entry: "src/index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      minify: true,
    },
    {
      label: "Node (CJS)",
      entry: "src/index.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      naming: { entry: "index.node.js" },
      renames: [["index.node.js", "index.node.cjs"]],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport("../index.node") },
    { path: "browser/index.d.ts", content: reexport("../index.browser") },
    { path: "cjs/index.d.ts", content: reexport("../index") },
  ],
});
