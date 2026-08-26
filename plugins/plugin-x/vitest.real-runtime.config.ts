/**
 * Vitest config for plugin-x real-runtime suites (#24372): boots a real
 * PGLite-backed AgentRuntime (adapter, connector-account rows, and the
 * SqlMembershipService authority are all real) and requires every workspace
 * `@elizaos/*` package resolved to source, exactly like the shared
 * real-runtime configs in sibling connectors.
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
