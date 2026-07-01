#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
/**
 * Build script for @elizaos/plugin-discord (Node). Orchestration lives in the
 * shared driver; this lists only what differs. Two bundled entrypoints:
 *   - `dist/index.js`                       the plugin barrel (`.` export)
 *   - `dist/user-account-scraper/index.js`  the `./user-account-scraper` subpath
 *     export — its own dedicated Node bundle so the export map's runtime target
 *     resolves to a real emitted file (used by plugin-personal-assistant).
 * Both are accompanied by a per-file `.d.ts` tree (emitted by tsc over the whole
 * source tree, so `dist/user-account-scraper/index.d.ts` is produced too), whose
 * bare relative re-exports are rewritten to NodeNext-resolvable paths.
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
		{
			label: "user-account-scraper subpath",
			entry: "user-account-scraper/index.ts",
			outSubdir: "user-account-scraper",
			target: "node",
			format: "esm",
		},
	],
	dtsProject: "tsconfig.build.json",
	rewriteDistImports: true,
});

await mkdir("dist/user-account-scraper", { recursive: true });
await writeFile(
	"dist/user-account-scraper/index.js",
	'export * from "../index.js";\n',
);
