#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-vision (Node ESM main + CJS workers).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs.
 *
 * Note: `build:native` (native/yolo.cpp/build.mjs) is a separate script and is
 * NOT part of this `build` step.
 */
import { buildPlugin } from "../plugin-build";

const NODE_BUILTINS = [
  "fs",
  "path",
  "http",
  "https",
  "crypto",
  "node:fs",
  "node:path",
  "node:http",
  "node:https",
  "node:crypto",
  "node:stream",
  "node:buffer",
  "node:util",
  "node:events",
  "node:url",
] as const;

// Externalize plugin-computeruse even though it is NOT a package.json
// dependency: plugin-vision dynamically imports its OCR seam
// (`@elizaos/plugin-computeruse/mobile/ocr-provider`) at boot via a
// best-effort import. It MUST stay external so the registry singleton is the
// one runtime instance computeruse reads — bundling a copy would split the
// registry and the registration would be invisible to computeruse.
const OPTIONAL_PEERS = ["@elizaos/plugin-computeruse"] as const;

// Worker-only externals (sharp's native/optional transitive deps). The main
// entrypoints never reference these, so folding them into the single shared
// external set leaves the main bundle byte-identical while keeping the worker
// bundles externalizing them exactly as before.
const WORKER_EXTRAS = [
  "@mapbox/node-pre-gyp",
  "mock-aws-s3",
  "aws-sdk",
  "nock",
] as const;

await buildPlugin({
  name: "@elizaos/plugin-vision",
  clean: true,
  externals: "auto",
  externalsOptions: {
    extra: [...NODE_BUILTINS, ...OPTIONAL_PEERS, ...WORKER_EXTRAS],
  },
  targets: [
    {
      // index.ts is the package entry; som.ts is also a published subpath
      // (`@elizaos/plugin-vision/som`, #9170 M9) consumed by computeruse's
      // detect_elements/grounding, so emit it as its own dist entrypoint.
      label: "Node",
      entry: ["./src/index.ts", "./src/som.ts"],
      outSubdir: "",
      target: "node",
      format: "esm",
      splitting: false,
      sourcemap: "external",
      naming: { entry: "[dir]/[name].[ext]" },
    },
    {
      // Workers need CommonJS format.
      label: "Workers",
      entry: [
        "./src/workers/screen-capture-worker.ts",
        "./src/workers/ocr-worker.ts",
      ],
      outSubdir: "workers",
      target: "node",
      format: "cjs",
      splitting: false,
      sourcemap: "linked",
      naming: { entry: "[name].[ext]" },
    },
  ],
  dtsProject: "tsconfig.build.json",
});
