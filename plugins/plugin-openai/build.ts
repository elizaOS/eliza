#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-openai (Node + Browser).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

// Single-quoted re-export to keep the emitted .d.ts byte-stable.
const reexport = "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-openai",
  targets: [
    { label: "Node", entry: "index.node.ts", outSubdir: "node", target: "node", format: "esm" },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      minify: true,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
  ],
});
