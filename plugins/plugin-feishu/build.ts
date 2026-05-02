#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-feishu TypeScript implementation
 */

import { runBuild } from "../../packages/core/build";

async function buildAll(): Promise<boolean> {
	const ok = await runBuild({
		packageName: "@elizaos/plugin-feishu",
		buildOptions: {
			entrypoints: ["src/index.ts"],
			outdir: "dist",
			target: "node",
			format: "esm",
			external: ["@elizaos/core", "@larksuiteoapi/node-sdk"],
			sourcemap: true,
			minify: false,
			generateDts: true,
		},
	});

	return ok;
}

buildAll()
	.then((ok) => {
		if (!ok) process.exit(1);
	})
	.catch((error) => {
		console.error("Build script error:", error);
		process.exit(1);
	});
