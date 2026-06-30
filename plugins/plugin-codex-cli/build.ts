#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-codex-cli (Node + Browser).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this lists
 * only what differs. The emitted `dist/` is byte-identical to the previous
 * hand-rolled build.
 */
import { buildPlugin } from "../plugin-build";

// Single-quoted re-export to keep the emitted .d.ts byte-stable.
const reexport = "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-codex-cli",
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
      minify: true,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
  ],
});
