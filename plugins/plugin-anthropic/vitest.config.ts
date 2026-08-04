/** Default vitest config: runs the `__tests__/**` shape/unit suite in Node, excluding the live and real-runtime lanes. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
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
