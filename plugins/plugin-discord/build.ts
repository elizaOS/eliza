#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-discord (Node). Orchestration lives in the
 * shared driver; this lists only what differs. Single bundled `dist/index.js`
 * plus a per-file `.d.ts` tree, whose bare relative re-exports are rewritten to
 * NodeNext-resolvable paths.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
	name: "@elizaos/plugin-discord",
	clean: true,
	targets: [
		{
			label: "Node",
			entry: "index.ts",
			outSubdir: "",
			target: "node",
			format: "esm",
		},
	],
	dtsProject: "tsconfig.build.json",
	rewriteDistImports: true,
});
