#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-anthropic (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

const reexport = "export * from '../index';\nexport { default } from '../index';\n";
const rootDeclaration = `import type { Plugin } from "@elizaos/core";

export declare const anthropicPlugin: Plugin;
declare const _default: Plugin;
export default _default;
`;

await buildPlugin({
  name: "@elizaos/plugin-anthropic",
  targets: [
    { label: "Node", entry: "index.node.ts", outSubdir: "node", target: "node", format: "esm" },
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
    { path: "index.d.ts", content: rootDeclaration },
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
