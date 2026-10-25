#!/usr/bin/env bun
/** Builds the Discord connector's single Node ESM entry and NodeNext-compatible declarations. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
	name: "@elizaos/plugin-discord",
	clean: true,
	targets: [
		{
			label: "Node ESM",
			entry: "index.ts",
			outSubdir: "",
			target: "node",
			format: "esm",
		},
	],
	dtsProject: "tsconfig.build.json",
	rewriteDistImports: true,
});
