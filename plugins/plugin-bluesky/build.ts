#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-bluesky (Node + Browser + Node CJS).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs. The emitted `dist/` is byte-identical to the
 * previous hand-rolled build.
 *
 * Each runtime target deliberately bundles `index.ts` (the real entry) rather
 * than the `index.node.ts` re-export shim. Bundling the shim triggers a
 * Bun.build codegen bug where the inlined default export is renamed to
 * `default2` but the corresponding `var default2 = ...` declaration is never
 * emitted, producing an unimportable bundle (`"default2" is not declared in
 * this file`). The Node/CJS outputs are renamed to `index.node.js` /
 * `index.node.cjs` afterwards (via `renames`) so the package.json `exports`
 * map remains stable.
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) =>
	`export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
	name: "@elizaos/plugin-bluesky",
	targets: [
		{
			label: "Node",
			entry: "index.ts",
			outSubdir: "node",
			target: "node",
			format: "esm",
			sourcemap: "external",
			renames: [
				["index.js", "index.node.js"],
				["index.js.map", "index.node.js.map"],
			],
		},
		{
			label: "Browser",
			entry: "index.browser.ts",
			outSubdir: "browser",
			target: "browser",
			format: "esm",
			sourcemap: "external",
		},
		{
			label: "Node (CJS)",
			entry: "index.ts",
			outSubdir: "cjs",
			target: "node",
			format: "cjs",
			sourcemap: "external",
			renames: [
				["index.js", "index.node.cjs"],
				["index.js.map", "index.node.cjs.map"],
			],
		},
	],
	dtsProject: "tsconfig.build.json",
	dtsShims: [
		{ path: "index.d.ts", content: reexport("./node/index") },
		{ path: "browser/index.d.ts", content: reexport("./index.browser") },
		{ path: "cjs/index.d.ts", content: reexport("./index.node") },
	],
});
