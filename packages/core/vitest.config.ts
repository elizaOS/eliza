/** Configures the deterministic Vitest harness for @elizaos/core test suites. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";

export default defineConfig({
	resolve: {
		conditions: ["eliza-source"],
		alias: buildWorkspaceSourceAliases(),
	},
	test: {
		hookTimeout: 60_000,
		testTimeout: 60_000,
		fileParallelism: false,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.claude/**",
			".claude/**",
			"**/*.e2e.test.*",
			"**/*.live.e2e.test.*",
			"**/*.real.e2e.test.*",
			// #9310 §E: the guarded live/real suites (they self-skip without
			// creds/opt-in) are invocable only in the post-merge lane, where
			// run-all-tests.ts prints a named skip accounting. The unguarded
			// live/real files stay excluded in every lane.
			...(process.env.VITEST_LANE === "post-merge"
				? []
				: ["**/*.live.test.*", "**/*.real.test.*"]),
			// Playwright e2e specs must be run with `npm run test:e2e` (playwright test), not vitest
			"e2e/**",
		],
	},
});
