/**
 * Vitest config for the Slack plugin's fast unit tests. Runs against
 * workspace source packages without a live workspace.
 *
 * `*.real.test.ts` files boot a real PGLite runtime and need the workspace
 * source aliases from vitest.real-runtime.config.ts — run those via
 * `test:real-runtime`.
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
    exclude: ["**/node_modules/**", "dist/**", "**/*.real.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
