/**
 * Vitest config for this plugin's Node-only test suite: forces `node` resolution
 * conditions (for `@elizaos/core`'s dual ESM/CJS entry points) and inlines it into
 * the SSR module graph so the forked-pool transform can process the workspace package.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		conditions: ["node"],
	},
	ssr: {
		resolve: {
			conditions: ["node"],
		},
	},
	test: {
		environment: "node",
		include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
		testTimeout: 15_000,
		pool: "forks",
		server: {
			deps: {
				inline: ["@elizaos/core"],
			},
		},
	},
});
