import path from "node:path";
import { defineConfig } from "vitest/config";
import { repoRoot } from "../../packages/test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../packages/test/vitest/workspace-aliases";

const pluginSqlRoot = path.join(
	getElizaWorkspaceRoot(repoRoot),
	"plugins",
	"plugin-sql",
	"typescript",
);

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@elizaos\/plugin-sql$/,
				replacement: path.join(pluginSqlRoot, "index.node.ts"),
			},
			{
				find: /^@elizaos\/plugin-sql\/schema$/,
				replacement: path.join(pluginSqlRoot, "schema", "index.ts"),
			},
			{
				find: /^@elizaos\/plugin-sql\/types$/,
				replacement: path.join(pluginSqlRoot, "types.ts"),
			},
			{
				find: /^@elizaos\/plugin-sql\/(.+)$/,
				replacement: path.join(pluginSqlRoot, "$1"),
			},
		],
	},
	test: {
		hookTimeout: 60_000,
		testTimeout: 60_000,
		fileParallelism: false,
		// Coverage floor — established at a conservative 1% to wire the mechanism
		// (issue #9943). Inert in normal CI: run-vitest.mjs never passes --coverage,
		// so thresholds only evaluate when a run explicitly opts in, at which point a
		// full-suite run clears 1% trivially. Raise toward the measured baseline as a
		// follow-up; see .github/workflows/coverage-gate.yml.
		coverage: {
			thresholds: {
				lines: 1,
				functions: 1,
				branches: 1,
				statements: 1,
			},
		},
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.claude/**",
			".claude/**",
			"**/*.e2e.test.*",
			"**/*.live.test.*",
			"**/*.live.e2e.test.*",
			"**/*.real.test.*",
			"**/*.real.e2e.test.*",
			// Playwright e2e specs must be run with `npm run test:e2e` (playwright test), not vitest
			"e2e/**",
		],
	},
});
