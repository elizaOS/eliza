#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-commands: bundles the Node ESM entry via the
 * shared `buildPlugin` helper, keeping `@elizaos/core` external.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
	name: "@elizaos/plugin-commands",
	externals: ["@elizaos/core"],
	targets: [
		{
			label: "Node (ESM)",
			entry: "./src/index.ts",
			outSubdir: "",
			target: "node",
			format: "esm",
			splitting: false,
		},
		{
			label: "Node (CJS)",
			entry: "./src/index.ts",
			outSubdir: "cjs",
			target: "node",
			format: "cjs",
			splitting: false,
			naming: { entry: "[dir]/[name].cjs" },
		},
	],
	dtsProject: "tsconfig.json",
	dtsEmitDeclarationOnly: true,
});
