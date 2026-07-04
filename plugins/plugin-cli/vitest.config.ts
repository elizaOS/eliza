/**
 * Vitest configuration for the CLI plugin: node environment, serial execution
 * (single worker, no file parallelism) so the module-level command registry
 * stays isolated between suites, with the core logger mock loaded as a setup file.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: [
			"__tests__/**/*.test.ts",
			"__tests__/**/*.test.tsx",
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"test/**/*.test.ts",
			"test/**/*.test.tsx",
		],
		exclude: [
			"dist/**",
			"**/node_modules/**",
			"**/*.live.test.ts",
			"**/*.e2e.test.ts",
		],
		testTimeout: 60000,
		hookTimeout: 60000,
		fileParallelism: false,
		maxWorkers: 1,
		setupFiles: ["./__tests__/core-test-mock.ts"],
		sequence: {
			concurrent: false,
		},
	},
});
