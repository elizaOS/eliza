import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
