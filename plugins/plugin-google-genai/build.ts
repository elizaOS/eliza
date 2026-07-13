#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-google-genai (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

const reexport =
  "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-google-genai",
  targets: [
    {
      label: "Node",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
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
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
