import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");
const coreSrc = path.resolve(__dirname, "../../packages/core/src");

export default defineConfig({
	resolve: {
		alias: [
			// Use workspace source for @elizaos/shared and @elizaos/core so
			// recently-added exports resolve at test time without requiring
			// a fresh dist build of either package.
			{
				find: /^@elizaos\/shared\/(.*)\.js$/,
				replacement: path.join(sharedSrc, "$1.ts"),
			},
			{
				find: /^@elizaos\/shared\/(.*)$/,
				replacement: path.join(sharedSrc, "$1.ts"),
			},
			{
				find: "@elizaos/shared",
				replacement: path.join(sharedSrc, "index.ts"),
			},
			{
				find: /^@elizaos\/core\/(.*)\.js$/,
				replacement: path.join(coreSrc, "$1.ts"),
			},
			{
				find: "@elizaos/core",
				replacement: path.join(coreSrc, "index.node.ts"),
			},
		],
	},
	test: {
		globals: false,
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		root: path.resolve(__dirname),
		coverage: {
			reporter: ["text", "json", "html"],
			exclude: ["node_modules", "dist", "**/*.test.ts"],
		},
		deps: {
			optimizer: {
				web: { enabled: false },
				ssr: { enabled: false },
			},
		},
	},
});
