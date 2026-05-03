import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/tests/e2e/**"],
    // Skip tests gracefully when native dependencies are missing
    passWithNoTests: true,
    // Give more time for tests that load heavy dependencies
    testTimeout: 30000,
  },
});
