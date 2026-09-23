#!/usr/bin/env bun
/** Explicit Node storage implementations; all emitted artifacts belong in dist. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-inmemorydb",
  clean: true,
  externals: ["@elizaos/core"],
  targets: [
    { label: "Node", entry: "./index.ts", outSubdir: ".", target: "node", format: "esm" },
    {
      label: "Isolated runtime adapter",
      entry: "./runtime.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsTolerant: false,
});
