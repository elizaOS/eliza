#!/usr/bin/env bun
/** Builds the MCP plugin's single Node ESM entry and direct public declarations. */
import { readdirSync } from "node:fs";
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-mcp",
  clean: true,
  externals: "auto",
  targets: [
    {
      label: "Protocol utilities",
      entry: readdirSync(new URL("./src/protocol-utils/", import.meta.url))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => `src/protocol-utils/${name}`),
      outSubdir: "protocol-utils",
      target: "node",
      format: "esm",
      naming: { entry: "[name].[ext]" },
    },
    {
      label: "Node ESM",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "external",
      minify: false,
    },
  ],
  dtsProject: "tsconfig.build.json",
});
