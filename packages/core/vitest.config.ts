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
const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const contractsSrc = path.join(
	elizaWorkspaceRoot,
	"packages",
	"contracts",
	"src",
);
const loggerSrc = path.join(elizaWorkspaceRoot, "packages", "logger", "src");
const promptsSrc = path.join(elizaWorkspaceRoot, "packages", "prompts", "src");

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
			{
				find: /^@elizaos\/contracts$/,
				replacement: path.join(contractsSrc, "index.ts"),
			},
			{
				find: /^@elizaos\/contracts\/(.+)$/,
				replacement: path.join(contractsSrc, "$1"),
			},
			{
				find: /^@elizaos\/logger$/,
				replacement: path.join(loggerSrc, "index.ts"),
			},
			{
				find: /^@elizaos\/prompts$/,
				replacement: path.join(promptsSrc, "index.ts"),
			},
			{
				find: /^@elizaos\/prompts\/(.+)$/,
				replacement: path.join(promptsSrc, "$1"),
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
