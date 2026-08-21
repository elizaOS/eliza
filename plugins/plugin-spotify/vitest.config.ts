/** Runs Spotify plugin tests against workspace source packages. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const workspaceAliases = buildWorkspaceSourceAliases();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
