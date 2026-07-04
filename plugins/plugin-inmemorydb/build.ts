#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-inmemorydb (Node + Browser). Orchestration
 * lives in the shared driver (plugins/plugin-build.ts); this lists only what
 * differs: the dual Node/Browser targets, a fixed `naming` template and
 * `linked` sourcemaps (both determine the emitted bytes, so they are pinned
 * here), and `dtsShims` that write root + node `.d.ts` aliases re-exporting
 * the browser build.
 */
import { buildPlugin } from "../plugin-build";

const naming = {
  entry: "[dir]/[name].[ext]",
  chunk: "[name]-[hash].[ext]",
  asset: "[name]-[hash].[ext]",
} as const;

const rootAlias = [
  'export * from "./browser/index";',
  'export { default } from "./browser/index";',
  "",
].join("\n");

const nodeAlias = [
  'export * from "../browser/index";',
  'export { default } from "../browser/index";',
  "",
].join("\n");

await buildPlugin({
  name: "@elizaos/plugin-inmemorydb",
  clean: true,
  externals: ["@elizaos/core"],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
    {
      label: "Browser",
      entry: "./index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsTolerant: true,
  dtsShims: [
    { path: "index.d.ts", content: rootAlias },
    { path: "node/index.d.ts", content: nodeAlias },
  ],
});
