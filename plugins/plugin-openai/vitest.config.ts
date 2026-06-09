import path from "node:path";
import { defineConfig } from "vitest/config";

const elizaRoot = path.resolve(import.meta.dirname, "../..");
const contractsSrc = path.join(elizaRoot, "packages/contracts/src");
const coreSrc = path.join(elizaRoot, "packages/core/src");
const loggerSrc = path.join(elizaRoot, "packages/logger/src");
const promptsSrc = path.join(elizaRoot, "packages/prompts/src");
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
			{
				find: /^@elizaos\/core$/,
				replacement: path.join(coreSrc, "index.node.ts"),
			},
			{
				find: /^@elizaos\/core\/(.+)$/,
				replacement: path.join(coreSrc, "$1"),
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
		environment: "node",
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/*.live.test.ts",
			"**/*.real.test.ts",
		],
	},
});
