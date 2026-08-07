/**
 * Vitest config for the keyless `createTestRuntimeWithModelProvider()` e2e (#8801, gap 5).
 *
 * Booting a real PGLite-backed AgentRuntime via `@elizaos/core/testing`
 * requires every workspace `@elizaos/*` package resolved to source. The shared Vitest configuration
 * owns that alias set (`buildWorkspaceSourceAliases`); this config reuses it so
 * the per-plugin e2e and the core model-provider suite never drift.
 */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.real.test.ts"],
		exclude: ["dist/**", "**/node_modules/**"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		pool: "forks",
	},
	resolve: {
		alias: buildWorkspaceSourceAliases(),
	},
});
