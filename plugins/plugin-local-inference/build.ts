#!/usr/bin/env bun
/**
 * Bundles the plugin's public entrypoints with `Bun.build` (ESM, workspace and
 * native deps kept external) and emits `.d.ts` declarations via tsc, then
 * smoke-imports the built route/voice barrels to catch resolution breaks the
 * bundler does not surface on its own.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
	new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

function rmRecursive(target: string) {
	const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`rm-path-recursive failed for ${target} with status ${result.status}`,
		);
	}
}

const external = await externalsFromPackageJson("./package.json", {
	// Transitive workspace deps + native sub-packages + wildcards the prior
	// hand-list relied on. `llama-cpp-capacitor` is the canonical mobile
	// binding; bun:* covers the desktop bun:ffi loader.
	extra: [
		"@elizaos/agent",
		// AOSP-only companion plugin, reached via a lazy `import(...)` gated on
		// ELIZA_LOCAL_LLAMA (getAospLocalInferenceApi in local-inference-routes).
		// It is not a declared dependency (present only on AOSP images), so the
		// mobile bundler must treat it as external or the build fails to resolve
		// it on every stock target.
		"@elizaos/plugin-aosp-local-inference",
		"llama-cpp-capacitor",
		"@reflink/reflink",
		"ws",
		"node:*",
		"bun:*",
	],
});

console.log("🔨 Building @elizaos/plugin-local-inference...");
const start = Date.now();

rmRecursive("dist");

const result = await Bun.build({
	// Entrypoints MUST start with "./". Without it, Bun.build mis-roots
	// relative-import resolution for secondary entrypoints and can fail with
	// "Could not resolve" on Linux CI while still building on macOS
	// (oven-sh/bun#12734).
	entrypoints: [
		"./src/index.ts",
		"./src/local-inference-routes.ts",
		"./src/runtime/index.ts",
		"./src/routes/index.ts",
		"./src/services/index.ts",
		"./src/voice-wake.ts",
		"./src/voice-workbench.ts",
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

await import(new URL("./dist/local-inference-routes.js", import.meta.url).href);
await import(new URL("./dist/voice-wake.js", import.meta.url).href);
await import(new URL("./dist/voice-workbench.js", import.meta.url).href);

console.log(
	`✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
);
