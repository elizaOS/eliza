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
		passWithNoTests: true,
		sequence: {
			concurrent: false,
		},
	},
});
