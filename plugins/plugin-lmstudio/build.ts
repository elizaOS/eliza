#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-lmstudio (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

const reexport = "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-lmstudio",
  clean: true,
  externals: ["@elizaos/core", "ai", "@ai-sdk/openai-compatible"],
  targets: [
    {
      label: "Node ESM",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming: { entry: "index.node.js" },
    },
    {
      label: "Browser ESM",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      naming: { entry: "index.browser.js" },
    },
    {
      label: "CJS",
      entry: "index.node.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      sourcemap: "linked",
      naming: { entry: "index.node.cjs" },
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsTolerant: true,
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
