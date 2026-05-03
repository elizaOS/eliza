import { defineConfig } from "vitest/config";

export default defineConfig({
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
