import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");

export default defineConfig({
	resolve: {
		alias: [
			// Use workspace source for @elizaos/shared so newly-added subpath
			// exports (e.g. ./contracts/app-permissions) resolve at test time
			// without requiring a fresh dist build of @elizaos/shared.
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
