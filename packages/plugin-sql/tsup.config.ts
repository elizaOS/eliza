import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/migrate.ts"],
	outDir: "dist",
	sourcemap: true,
	clean: true,
	format: ["esm"], // Ensure you're targeting CommonJS
	dts: false, // Skip DTS generation to avoid external import issues
	tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
	external: [
		"dotenv", // Externalize dotenv to prevent bundling
		"fs", // Externalize fs to use Node.js built-in module
		"path", // Externalize other built-ins if necessary
		"@reflink/reflink",
		"@node-llama-cpp",
		"https",
		"http",
		"agentkeepalive",
		"uuid",
		"@elizaos/core", // Also externalize the core package
		// Add other modules you want to externalize
	],
	// Improve source map configuration
	esbuildOptions(options) {
		options.sourceRoot = "./"; // Set source root to help with source mapping
		options.sourcesContent = true;
		options.outbase = "./src"; // Makes output paths match input structure
	},
	keepNames: true, // Preserve names for better debugging
});
