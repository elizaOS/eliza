import { defineConfig } from "tsup";

export default defineConfig({
	clean: true,
	entry: ["src/index.ts", "src/commands/*.ts"],
	format: ["esm"],
	dts: false,
	sourcemap: false,
	noExternal: [],
	platform: "node",
	minify: true,
	target: "esnext",
	outDir: "dist",
	tsconfig: "tsconfig.json",
	banner: {
		js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
	},
	esbuildOptions(options) {
		options.alias = {
			"@/src": "./src"
		};
	}
});
