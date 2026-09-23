#!/usr/bin/env bun
/** Builds the Node-only persistent agent database plugin. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-sqlite",
  clean: true,
  externals: ["@elizaos/core", "@elizaos/plugin-inmemorydb", "node:sqlite"],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsTolerant: false,
});
