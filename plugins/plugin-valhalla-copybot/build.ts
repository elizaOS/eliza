#!/usr/bin/env bun
/** Builds the Valhalla copybot plugin Node ESM entry and declarations. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-valhalla-copybot",
  clean: true,
  externals: ["@elizaos/core", "@solana/web3.js", "bs58"],
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
