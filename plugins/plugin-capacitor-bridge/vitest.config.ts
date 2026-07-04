/**
 * Vitest configuration for the Capacitor bridge package.
 *
 * Bridge tests run serially in Node because several suites mutate process env,
 * module caches, abstract sockets, or singleton bridge state.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
		fileParallelism: false,
		maxWorkers: 1,
	},
});
