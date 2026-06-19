import { build } from "bun";

await build({
	entrypoints: ["./src/index.ts"],
	outdir: "./dist",
	target: "node",
	format: "esm",
	splitting: false,
	sourcemap: "external",
	minify: false,
	external: ["@elizaos/core"],
});

// Build CJS version
await build({
	entrypoints: ["./src/index.ts"],
	outdir: "./dist/cjs",
	target: "node",
	format: "cjs",
	splitting: false,
	sourcemap: "external",
	minify: false,
	external: ["@elizaos/core"],
	naming: "[dir]/[name].cjs",
});

console.log("Build complete!");
