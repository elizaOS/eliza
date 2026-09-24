#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-embeddings (Node ESM + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

// Declarations are emitted under dist/node; every conditional package entry
// must resolve that actual tree rather than a nonexistent dist/index.d.ts.
const reexport =
  "export * from '../node/index.node';\nexport { default } from '../node/index.node';\n";

await buildPlugin({
  name: "@elizaos/plugin-embeddings",
  clean: true,
  externals: ["@elizaos/core"],
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
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
