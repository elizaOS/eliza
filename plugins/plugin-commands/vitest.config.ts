/**
 * Vitest configuration for command parser and action tests in Node.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts"],
		environment: "node",
	},
});
