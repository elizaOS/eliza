import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/*.live.test.ts",
			"**/*.real.test.ts",
			"**/*.e2e.test.ts",
			"**/*.live.e2e.test.ts",
			"**/*.real.e2e.test.ts",
		],
		passWithNoTests: true,
	},
});
