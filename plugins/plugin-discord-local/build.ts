#!/usr/bin/env bun
/**
 * Standalone build script for @elizaos/plugin-discord-local.
 * Runs the shared `buildPlugin` driver over Bun's native bundler (no monorepo
 * build-utils dependency): a single Node ESM bundle (`dist/index.js` + linked
 * sourcemap) plus a tolerant `tsc` declaration pass to `dist/src/`.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-discord-local",
  externals: "auto",
  externalsOptions: {
    // Bare-string node builtins: source that imports these without the `node:`
    // prefix still resolves externally under Bun.build.
    extra: [
      "fs",
      "path",
      "os",
      "http",
      "https",
      "crypto",
      "stream",
      "events",
      "util",
      "url",
      "net",
      "tls",
      "zlib",
      "buffer",
      "child_process",
      "readline",
    ],
  },
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
  // Emit real declaration files via tsc; non-fatal — the plugin works at
  // runtime without .d.ts files.
  dtsProject: "tsconfig.build.json",
  dtsTolerant: true,
});
