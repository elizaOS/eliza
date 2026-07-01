#!/usr/bin/env bun
/**
 * Standalone build script for @elizaos/plugin-discord-local.
 * Uses Bun's native bundler — no monorepo build-utils dependency.
 *
 * Migrated onto the shared `buildPlugin` driver (issue #10078). Emits the
 * same single Node ESM bundle (`dist/index.js` + linked sourcemap) and the
 * tolerant `tsc` declaration pass to `dist/src/`, byte-identical to the prior
 * hand-rolled build.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-discord-local",
  externals: "auto",
  externalsOptions: {
    // Preserve the bare-string node builtins the prior hand-list included so
    // any source that imports them without the `node:` prefix still resolves
    // externally under Bun.build.
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
