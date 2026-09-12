/**
 * Vitest config for wire-fidelity real-runtime e2e (#29751 review evidence).
 *
 * Mirrors plugin-telegram's real-runtime config: workspace source aliases are
 * required so `@elizaos/core/testing` boots a real PGLite-backed AgentRuntime
 * resolved to source.
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
