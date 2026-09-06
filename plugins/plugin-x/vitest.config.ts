/** Runs X connector tests against the real workspace package graph. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const testAliases = buildWorkspaceSourceAliases();

export default defineConfig({
  resolve: {
    alias: testAliases,
  },
  test: {
    alias: testAliases,
    globals: true,
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    // `*.real.test.ts` boots a real PGLite runtime and needs the workspace
    // source aliases from vitest.real-runtime.config.ts — run via
    // `test:real-runtime`.
    exclude: ["**/node_modules/**", "dist/**", "__tests__/**/*.real.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
