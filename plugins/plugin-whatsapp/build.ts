#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-whatsapp (Node). Orchestration lives in the shared
 * driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * The `extra` externals preserve bare-string node builtins, transitive
 * workspace packages, and optional native sub-packages the hand-list relied on.
 * The `@node-llama-cpp/*` glob covers per-platform subpackages that aren't
 * direct deps but must stay external so absent platforms don't fail to resolve.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-whatsapp",
  clean: true,
  externals: "auto",
  externalsOptions: {
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
      "@elizaos/shared",
      "@elizaos/agent",
      "@elizaos/vault",
      "@elizaos/cloud-routing",
      "node-llama-cpp",
      "@node-llama-cpp/*",
      "@napi-rs/keyring",
      "@reflink/reflink",
      "ipull",
      "tailwindcss",
      "zlib-sync",
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
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsTolerant: true,
});
