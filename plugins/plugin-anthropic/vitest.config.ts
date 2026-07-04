/** Default vitest config: runs the `__tests__/**` shape/unit suite in Node, excluding the live and harness lanes. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		// `*.harness.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.harness.config.ts — run via `test:harness`.
		exclude: [
			"dist/**",
			"node_modules/**",
			"**/*.live.test.ts",
			"**/*.harness.test.ts",
		],
	},
});
