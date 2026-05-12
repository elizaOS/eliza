import path from "node:path";
import { defineConfig } from "vitest/config";
import { repoRoot } from "../../test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../test/vitest/workspace-aliases";

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
			"**/*.live.test.*",
			"**/*.live.e2e.test.*",
			"**/*.real.test.*",
			"**/*.real.e2e.test.*",
			// Playwright e2e specs must be run with `npm run test:e2e` (playwright test), not vitest
			"e2e/**",
		],
	},
});
