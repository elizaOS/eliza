import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
	sourcemap: true,
	clean: true,
	format: ["esm"], // Ensure you're targeting CommonJS
	dts: false, // Skip DTS generation to avoid external import issues
	external: [],
});
