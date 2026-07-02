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
			// run-all-tests.mjs prints a named skip accounting. The unguarded
			// live/real files stay excluded in every lane.
			...(process.env.VITEST_LANE === "post-merge"
				? [
						"src/__tests__/read-attachment-action.live.test.ts",
						"src/features/trust/should-respond-risk-gate.real.test.ts",
					]
				: ["**/*.live.test.*", "**/*.real.test.*"]),
			// Playwright e2e specs must be run with `npm run test:e2e` (playwright test), not vitest
			"e2e/**",
		],
	},
});
