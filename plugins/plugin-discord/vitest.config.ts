/**
 * Vitest config for the Discord plugin's unit tests. Extends the repo's shared
 * base config so workspace packages (@elizaos/core, shared, logger, …) resolve
 * from SOURCE — required by lanes that run before any workspace build (the
 * changed-file coverage gate builds nothing) and harmless when dists exist.
 * Adds source aliases for the plugin's own unbuilt workspace deps on top.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

const baseResolveAliases = Array.isArray(baseConfig.resolve?.alias)
	? baseConfig.resolve.alias
	: [];
const baseTestAliases = Array.isArray(baseConfig.test?.alias)
	? baseConfig.test.alias
	: [];

// @elizaos/plugin-commands and @elizaos/plugin-meetings publish only built
// `dist/` entries and are outside the base config's alias set; resolve them
// from source so the suite needs no prebuild of either.
const pluginSourceAliases = [
	{
		find: /^@elizaos\/plugin-commands$/,
		replacement: path.join(repoRoot, "plugins/plugin-commands/src/index.ts"),
	},
	{
		find: /^@elizaos\/plugin-commands\/(.+)$/,
		replacement: path.join(repoRoot, "plugins/plugin-commands/src/$1"),
	},
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
		// `*.harness.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.harness.config.ts — run via `test:harness`.
		exclude: ["**/node_modules/**", "dist/**", "**/*.harness.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		root: pluginRoot,
		coverage: {
			...baseConfig.test?.coverage,
			// This plugin's sources live at the package root (service.ts,
			// discord-commands.ts, …), not under src/ — the base include of
			// "src/**/*.ts" collects nothing here, which reads to the changed-file
			// coverage gate as "changed source missing from LCOV".
			include: ["**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/__tests__/**",
				"test/**",
				"dist/**",
				"node_modules/**",
				"vitest.config.ts",
				"vitest.harness.config.ts",
				"build.ts",
			],
		},
	},
});
