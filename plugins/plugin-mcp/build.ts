#!/usr/bin/env bun
/** Builds the MCP plugin's single Node ESM entry and direct public declarations. */
import { buildPlugin } from "../plugin-build";
await buildPlugin({
    name: "@elizaos/plugin-mcp",
    clean: true,
    externals: "auto",
    targets: [
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
