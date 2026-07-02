import path from "node:path";
import { defineConfig } from "vitest/config";

const elizaRoot = path.resolve(import.meta.dirname, "../../..");
const pluginSqlRoot = path.join(
	elizaRoot,
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
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		// `*.real.test.ts` are kept in: they self-skip keyless (describe.skipIf)
		// and run live only in the nightly external-api-live-drift lane.
		// `*.harness.test.ts` boot a real PGLite runtime and need the workspace
		// source aliases from vitest.harness.config.ts — run via `test:harness`.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			// #9310 §E: the guarded live suites (trajectory + cerebras-refusal
			// self-skip without OPENAI_API_KEY_REAL / the opt-in gate) are
			// invocable only in the post-merge lane, where run-all-tests.mjs
			// prints a named skip accounting. The unguarded live files stay
			// excluded in every lane.
			...(process.env.VITEST_LANE === "post-merge"
				? [
						"__tests__/cerebras-config.live.test.ts",
						"__tests__/cloud-streaming.live.test.ts",
						"__tests__/native-plumbing.live.test.ts",
						"__tests__/openai.live.test.ts",
					]
				: ["**/*.live.test.ts"]),
			"**/*.harness.test.ts",
		],
	},
});
