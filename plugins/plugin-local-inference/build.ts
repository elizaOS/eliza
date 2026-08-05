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

export function rmRecursive(target: string) {
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

export async function buildLocalInferencePlugin(
	options: {
		rm?: (target: string) => void;
		externals?: typeof externalsFromPackageJson;
		build?: typeof Bun.build;
		emitDeclarations?: () => Promise<unknown>;
		smokeImport?: (specifier: string) => Promise<unknown>;
	} = {},
) {
	const resolveExternals = options.externals ?? externalsFromPackageJson;
	const build = options.build ?? Bun.build;
	const remove = options.rm ?? rmRecursive;
	const smokeImport =
		options.smokeImport ?? ((specifier: string) => import(specifier));
	const external = await resolveExternals("./package.json", {
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
			"@elizaos/plugin-native-inference",
			"llama-cpp-capacitor",
			"@reflink/reflink",
			"ws",
			"node:*",
			"bun:*",
		],
	});

	console.log("🔨 Building @elizaos/plugin-local-inference...");
	const start = Date.now();

	remove("dist");

	const result = await build({
		// Entrypoints MUST start with "./". Without it, Bun.build mis-roots
		// relative-import resolution for secondary entrypoints and can fail with
		// "Could not resolve" on Linux CI while still building on macOS
		// (oven-sh/bun#12734).
		entrypoints: [
			"./src/index.ts",
			"./src/actions/generate-media.ts",
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
		return 1;
	}

	console.log("📝 Generating TypeScript declarations...");
	// Declaration emit resolves workspace packages from their built types so it
	// cannot write dependency artifacts beside source files.
	await (
		options.emitDeclarations ??
		(() =>
			$`tsc6 --emitDeclarationOnly --declaration --noCheck --skipLibCheck -p tsconfig.build.json`.quiet())
	)();

	await smokeImport(
		new URL("./dist/local-inference-routes.js", import.meta.url).href,
	);
	await smokeImport(
		new URL("./dist/actions/generate-media.js", import.meta.url).href,
	);
	await smokeImport(new URL("./dist/voice-wake.js", import.meta.url).href);
	await smokeImport(new URL("./dist/voice-workbench.js", import.meta.url).href);

	console.log(
		`✅ Build complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
	);
	return 0;
}

if (import.meta.main) {
	const exitCode = await buildLocalInferencePlugin();
	if (exitCode !== 0) process.exit(exitCode);
}
