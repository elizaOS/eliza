/** tsup build config: bundles the barrel entry to ESM, keeping runtime-provided @elizaos/* and node deps external. */

import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	sourcemap: true,
	clean: true,
	format: ["esm"],
	external: ["dotenv", "fs", "path", "child_process", "@elizaos/core"],
});
