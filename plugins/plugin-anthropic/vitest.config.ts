/** Adapter integration checks; live and keyless-runtime suites have dedicated configs. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fsModuleCache: true,
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		// `*.real.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.real-runtime.config.ts — run via `test:real-runtime`.
		exclude: [
			"dist/**",
			"node_modules/**",
			"**/*.live.test.ts",
			"**/*.real.test.ts",
		],
	},
});
