/**
 * Vitest config for the Discord plugin's unit tests. Extends the repo's shared
 * base config so workspace packages (@elizaos/core, shared, logger, …) resolve
 * from source without requiring a workspace build. Adds source aliases for the
 * plugin's own unbuilt workspace dependencies.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

const baseResolveAliases = Array.isArray(baseConfig.resolve?.alias)
	? baseConfig.resolve.alias
	: [];
const baseTestAliases = Array.isArray(baseConfig.test?.alias)
	? baseConfig.test.alias
	: [];

// Resolve the meetings workspace from source without requiring a prebuild.
const pluginSourceAliases = [
	{
		find: /^@elizaos\/plugin-meetings$/,
		replacement: path.join(repoRoot, "plugins/plugin-meetings/src/index.ts"),
	},
];

export default defineConfig({
	...baseConfig,
	resolve: {
		...baseConfig.resolve,
		alias: [...pluginSourceAliases, ...baseResolveAliases],
	},
	test: {
		...baseConfig.test,
		alias: [...pluginSourceAliases, ...baseTestAliases],
		include: [
			"__tests__/**/*.test.ts",
			"actions/**/*.test.ts",
			"test/**/*.test.ts",
		],
		// `*.real.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.real-runtime.config.ts — run via `test:real-runtime`.
		exclude: ["**/node_modules/**", "dist/**", "**/*.real.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		root: pluginRoot,
		coverage: {
			...baseConfig.test?.coverage,
			// This plugin's sources live at the package root rather than src/.
			include: ["**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/__tests__/**",
				"test/**",
				"dist/**",
				"node_modules/**",
				"vitest.config.ts",
				"vitest.real-runtime.config.ts",
				"build.ts",
			],
		},
	},
});
