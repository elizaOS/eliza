/** Exercises the native SQLite adapter against current workspace sources in Node. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: { alias: buildWorkspaceSourceAliases() },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts", "*.test.ts"],
    environment: "node",
  },
});
