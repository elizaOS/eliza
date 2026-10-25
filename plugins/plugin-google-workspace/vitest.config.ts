/** Runs Google Workspace source tests against real workspace packages, excluding live/e2e specs. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const workspaceAliases = buildWorkspaceSourceAliases();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    alias: workspaceAliases,
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
  },
});
