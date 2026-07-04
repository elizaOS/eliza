/**
 * Vitest config for the plugin. Aliases provider SDK imports to shared shims so
 * unit tests run without the real `@atproto/api` SDK, and excludes the
 * `.live.test.ts` / `.e2e.test.ts` lanes from the default run.
 */
import { defineConfig } from "vitest/config";
import {
	providerSdkAliases,
	providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

export default defineConfig({
	resolve: {
		alias: providerSdkAliases,
	},
	plugins: [providerSdkShimPlugin()],
	test: {
		include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
		exclude: [
			"dist/**",
			"**/node_modules/**",
			"**/*.live.test.ts",
			"**/*.e2e.test.ts",
		],
	},
});
