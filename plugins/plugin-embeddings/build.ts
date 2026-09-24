#!/usr/bin/env bun
/** Builds the embeddings plugin's single Node ESM entry and declarations. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-embeddings",
  clean: true,
  externals: ["@elizaos/core"],
  targets: [
    {
      label: "Node ESM",
      entry: "src/index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming: { entry: "index.js" },
    },
  ],
  dtsProject: "tsconfig.build.json",
});
