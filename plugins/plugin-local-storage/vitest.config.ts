/** Vitest config for this plugin's unit tests (node environment; extended timeouts for real filesystem I/O). */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
