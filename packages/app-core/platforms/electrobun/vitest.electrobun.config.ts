import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreSrcRoot = path.resolve(__dirname, "../../src");
const appStewardSrcRoot = path.resolve(
	__dirname,
	"../../../../plugins/app-steward/src",
);
const sharedSrcRoot = path.resolve(__dirname, "../../../shared/src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@elizaos\/app-core$/,
				replacement: path.join(appCoreSrcRoot, "index.ts"),
			},
			{
				find: /^@elizaos\/app-core\/(.*)$/,
				replacement: path.join(appCoreSrcRoot, "$1"),
			},
			{
				find: /^@elizaos\/app-steward$/,
				replacement: path.join(appStewardSrcRoot, "index.ts"),
			},
			{
				find: /^@elizaos\/app-steward\/(.*)$/,
				replacement: path.join(appStewardSrcRoot, "$1"),
			},
			{
				find: /^@elizaos\/shared$/,
				replacement: path.join(sharedSrcRoot, "index.ts"),
			},
			{
				find: /^@elizaos\/shared\/(.*)$/,
				replacement: path.join(sharedSrcRoot, "$1"),
			},
			{
				find: /^bun:ffi$/,
				replacement: path.resolve(__dirname, "src/__stubs__/bun-ffi.ts"),
			},
			{
				find: /^electrobun\/bun$/,
				replacement: path.resolve(__dirname, "src/__stubs__/electrobun-bun.ts"),
			},
		],
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
	},
});
