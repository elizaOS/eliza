import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["dist/**", "**/node_modules/**"],
		globals: false,
		testTimeout: 30000,
	},
});
