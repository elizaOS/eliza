/**
 * Vitest config for the Groq plugin unit tests. `*.harness.test.ts` files are
 * excluded here (they need a real PGLite runtime + workspace aliases) and run
 * separately via vitest.harness.config.ts.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		// `*.harness.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.harness.config.ts — run via `test:harness`.
		exclude: ["**/node_modules/**", "dist/**", "**/*.harness.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
		setupFiles: ["./__tests__/core-test-mock.ts"],
	},
});
