import { defineConfig } from "tsup";

export default defineConfig({
	clean: true,
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: false,
	sourcemap: true,
	external: ["@electric-sql/pglite"],
	noExternal: [/^(?!@electric-sql\/pglite).*/],
	platform: "node",
	minify: false,
	target: "esnext",
	outDir: "dist",
	tsconfig: "tsconfig.json",
	banner: {
		js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
	},
});
