/** Exercises browser contracts against the current workspace source, including relocated host modules. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: buildWorkspaceSourceAliases(),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
