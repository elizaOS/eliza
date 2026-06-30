#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-linear",
  externalsOptions: {
    // Preserve transitive externals the hand-maintained list relied on.
    extra: ["dotenv", "fs", "path", "@reflink/reflink", "https", "http", "agentkeepalive", "zod"],
  },
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
});
