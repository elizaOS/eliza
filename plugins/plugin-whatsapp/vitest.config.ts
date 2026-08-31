/** Vitest configuration for the WhatsApp plugin test suite. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases";

export default defineConfig({
	resolve: {
		alias: buildWorkspaceSourceAliases(),
	},
	test: {
		include: [
			"__tests__/**/*.test.ts",
			"__tests__/**/*.test.tsx",
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"test/**/*.test.ts",
			"test/**/*.test.tsx",
		],
		exclude: ["dist/**", "**/node_modules/**"],
		testTimeout: 120_000,
	},
});
