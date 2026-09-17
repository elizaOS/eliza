#!/usr/bin/env bun
/** One Node ESM artifact; declarations stay inside this package's dist. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-google-genai",
  targets: [
    {
      label: "Node",
      entry: "index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
