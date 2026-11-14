import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreSrcRoot = path.resolve(__dirname, "../../src");
const srcRoot = path.resolve(__dirname, "src");
const coreSrcRoot = path.resolve(__dirname, "../../../core/src");

export default defineConfig({
	plugins: [
		{
			name: "bun-import-meta-dir",
			transform(code, id) {
				if (!id.startsWith(srcRoot) || !code.includes("import.meta.dir")) {
					return null;
				}
				return code.replace(/\bimport\.meta\.dir\b/g, "import.meta.dirname");
			},
		},
	],
	resolve: {
		alias: [
			{
				find: /^@elizaos\/core$/,
				replacement: path.join(coreSrcRoot, "index.ts"),
			},
			{
				find: /^@elizaos\/app$/,
				replacement: path.join(appCoreSrcRoot, "index.ts"),
			},
			{
				find: /^@elizaos\/app\/(.*)$/,
				replacement: path.join(appCoreSrcRoot, "$1"),
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
