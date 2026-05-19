import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	sourcemap: true,
	clean: true,
	format: ["esm"],
	external: [
		"dotenv",
		"fs",
		"path",
		"child_process",
		"@elizaos/core",
		// Phase 4E: skill routes/services depend on @elizaos/agent for
		// `resolveDefaultAgentWorkspaceDir` and `createIntegrationTelemetrySpan`.
		// The agent loads us at runtime; we must not bundle it.
		"@elizaos/agent",
		"@elizaos/shared",
		"@elizaos/skills",
		"fflate",
	],
});
