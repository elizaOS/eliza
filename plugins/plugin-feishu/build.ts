#!/usr/bin/env bun
/**
 * Builds @elizaos/plugin-feishu to dist/ via the shared buildPlugin driver
 * (plugins/plugin-build.ts); this file supplies only the plugin-specific config.
 * Emits a single Node ESM bundle at dist/index.js from src/index.ts with linked
 * sourcemaps, externalizing @elizaos/core and the Lark SDK, plus type
 * declarations from tsconfig.build.json.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
	name: "@elizaos/plugin-feishu",
	clean: true,
	externals: ["@elizaos/core", "@larksuiteoapi/node-sdk"],
	targets: [
		{
			label: "Node",
			entry: "./src/index.ts",
			outSubdir: "",
			target: "node",
			format: "esm",
			sourcemap: "linked",
			naming: {
				entry: "[dir]/[name].[ext]",
				chunk: "[name]-[hash].[ext]",
				asset: "[name]-[hash].[ext]",
			},
		},
	],
	dtsProject: "tsconfig.build.json",
	dtsEmitDeclarationOnly: true,
});
