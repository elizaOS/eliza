import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	clean: true,
	format: ["esm"],
	target: "node18",
	dts: false,
	external: [
		"dotenv",
		"fs",
		"path",
		"node:fs",
		"node:path",
		"http",
		"https",
		"sharp",
	],
	sourcemap: true
});
