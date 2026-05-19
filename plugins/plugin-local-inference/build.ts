#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const external = await externalsFromPackageJson("./package.json", {
	// Transitive workspace deps + native sub-packages + wildcards the prior
	// hand-list relied on. `llama-cpp-capacitor` is the canonical mobile
	// binding; bun:* covers the desktop bun:ffi loader. node-llama-cpp has
	// been removed.
	extra: [
		"@elizaos/agent",
		"@elizaos/plugin-omnivoice",
		"llama-cpp-capacitor",
		"@reflink/reflink",
		"ws",
		"node:*",
		"bun:*",
	],
});

console.log("🔨 Building @elizaos/plugin-local-inference...");
const start = Date.now();

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [
		"src/index.ts",
		"src/runtime/index.ts",
		"src/routes/index.ts",
		"src/services/index.ts",
	],
	outdir: "dist",
	target: "node",
	format: "esm",
	sourcemap: "external",
	external,
	minify: false,
	splitting: false,
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log("📝 Generating TypeScript declarations...");
// Override rootDir to src so declarations land directly in dist/ rather than nested under the monorepo rootDir
await $`tsc --emitDeclarationOnly --declaration --declarationDir dist --rootDir src --noCheck --skipLibCheck -p tsconfig.json`.quiet();

console.log(
	`✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
