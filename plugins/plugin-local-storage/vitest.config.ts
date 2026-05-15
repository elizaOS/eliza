import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		passWithNoTests: true,
	},
});
