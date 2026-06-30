#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-todos",
  externalsOptions: { extra: ["node:*"] },
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
