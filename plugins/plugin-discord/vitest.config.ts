import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

export default defineConfig({
	resolve: {
		// @elizaos/plugin-commands publishes only a built `dist/` entry. The
		// per-package test lanes prebuild just core/shared/logger/contracts/prompts,
		// so plugin-commands has no dist and vitest fails to resolve it ("Failed to
		// resolve entry for package @elizaos/plugin-commands"). Resolve it from
		// source instead — mirrors the same alias pattern other plugins use for
		// unbuilt workspace deps.
		alias: [
			{
				find: /^@elizaos\/plugin-commands$/,
				replacement: path.join(
					repoRoot,
					"plugins/plugin-commands/src/index.ts",
				),
			},
			{
				find: /^@elizaos\/plugin-commands\/(.+)$/,
				replacement: path.join(repoRoot, "plugins/plugin-commands/src/$1"),
			},
		],
	},
	test: {
		include: [
			"__tests__/**/*.test.ts",
			"actions/**/*.test.ts",
			"test/**/*.test.ts",
		],
		environment: "node",
		testTimeout: 60_000,
	},
});
