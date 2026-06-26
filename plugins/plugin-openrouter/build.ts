#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-openrouter (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 * Declarations are hand-written (no tsc emit).
 */
import { buildPlugin } from "../plugin-build";

const externals = ["@elizaos/core", "ai", "@openrouter/ai-sdk-provider", "@ai-sdk/openai"];
const reexport = "export * from '../index';\nexport { default } from '../index';\n";
const rootDeclaration = `import type { Plugin } from "@elizaos/core";

export declare const openrouterPlugin: Plugin;
declare const _default: Plugin;
export default _default;
`;

await buildPlugin({
  name: "@elizaos/plugin-openrouter",
  clean: true,
  externals,
  targets: [
    {
      label: "Node ESM",
      entry: "index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming: { entry: "index.node.js" },
    },
    {
      label: "Browser ESM",
      entry: "index.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      naming: { entry: "index.browser.js" },
    },
    {
      label: "CJS",
      entry: "index.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      sourcemap: "linked",
      naming: { entry: "index.node.cjs" },
    },
  ],
  dtsShims: [
    { path: "index.d.ts", content: rootDeclaration },
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
