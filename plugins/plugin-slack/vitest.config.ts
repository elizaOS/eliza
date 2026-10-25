/**
 * Runs Slack connector tests against workspace source packages without a live workspace.
 */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const workspaceAliases = buildWorkspaceSourceAliases();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    alias: workspaceAliases,
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
