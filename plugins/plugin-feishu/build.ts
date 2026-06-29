#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-feishu (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * Migrated from the legacy `runBuild` (packages/core/build) driver to the
 * shared `buildPlugin` driver as part of issue #10078 (one build helper). The
 * emitted `dist/` is byte-identical to the previous `runBuild` output.
 *
 * runBuild → buildPlugin mapping:
 *  - entrypoints ["src/index.ts"] → a single Node target (entry "./src/index.ts",
 *    outSubdir "" so the bundle lands at dist/index.js, target "node", esm).
 *  - sourcemap: true → "linked": runBuild passes the boolean `true` straight to
 *    Bun.build, which (in this Bun) emits an external `.js.map` plus a
 *    `//# sourceMappingURL=` + `//# debugId=` comment — exactly Bun's "linked"
 *    mode (verified byte-for-byte, including the debugId).
 *  - naming: createElizaBuildConfig sets a fixed naming template; it is what
 *    determines the sourcemap bytes (hence the debugId). Reproduced verbatim
 *    here so dist/index.js + dist/index.js.map are byte-identical.
 *  - external: runBuild appends Node built-ins + @elizaos/* to the passed list,
 *    but feishu's source only imports @elizaos/core + @larksuiteoapi/node-sdk,
 *    so the explicit two-entry list yields the identical bundle (verified).
 *  - generateDts: true → dtsProject "tsconfig.build.json" +
 *    dtsEmitDeclarationOnly (runBuild's generateDts runs
 *    `tsc --emitDeclarationOnly --noCheck`). No d.ts import rewrite / root alias
 *    is performed by runBuild, so none is configured here.
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
