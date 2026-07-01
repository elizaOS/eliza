import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "test/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    // `*.harness.test.ts` boot a real PGLite runtime and need the workspace
    // source aliases from vitest.harness.config.ts — run via `test:harness`.
    exclude: ["**/node_modules/**", "dist/**", "**/*.harness.test.ts"],
    setupFiles: ["./__tests__/core-test-mock.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
