#!/usr/bin/env bun
/**
 * Standalone build script for @elizaos/plugin-telegram-standalone.
 * Uses the shared `buildPlugin` driver — one Node ESM bundle
 * (`dist/index.js` + linked sourcemap) plus a tolerant `tsc` declaration
 * pass to `dist/src/`. `telegraf` and `@elizaos/*` stay external.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-telegram-standalone",
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      minify: false,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsTolerant: true,
});
