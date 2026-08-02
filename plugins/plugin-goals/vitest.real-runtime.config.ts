/**
 * Vitest config for the keyless `createTestRuntimeWithModelProvider()` e2e (#8801, gap 5).
 *
 * Booting a real PGLite-backed AgentRuntime via `@elizaos/core/testing`
 * requires every workspace `@elizaos/*` package resolved to source. The harness
 * owns that alias set (`buildWorkspaceSourceAliases`); this config reuses it so
 * the per-plugin e2e and the harness's own suite never drift.
 */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/test/vitest/source-aliases.ts";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.real.test.ts", "test/**/*.real.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
  resolve: {
    alias: buildWorkspaceSourceAliases(),
  },
});
