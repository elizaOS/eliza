/** Vitest config: runs the plugin's test files under Node with the core-mock setup file. */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		setupFiles: ["./src/__tests__/core-test-mock.ts"],
	},
});
