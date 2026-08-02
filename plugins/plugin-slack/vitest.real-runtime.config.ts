/** Runs Slack connector-loop tests against the real core runtime and deterministic model provider. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/test/vitest/source-aliases.ts";

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
