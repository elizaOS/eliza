import { defineConfig } from "vitest/config";

export default defineConfig({
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
