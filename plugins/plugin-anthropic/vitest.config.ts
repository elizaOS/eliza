import path from "node:path";
import { defineConfig } from "vitest/config";

const monorepoRoot = path.resolve(import.meta.dirname, "../..");
const contractsSrc = path.join(monorepoRoot, "packages/contracts/src");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const loggerSrc = path.join(monorepoRoot, "packages/logger/src");
const promptsSrc = path.join(monorepoRoot, "packages/prompts/src");

export default defineConfig({
	resolve: {
		alias: [
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
		include: ["__tests__/**/*.test.ts"],
		exclude: ["dist/**", "node_modules/**", "**/*.live.test.ts"],
		passWithNoTests: true,
	},
});
