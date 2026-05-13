import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/e2e/**",
      "**/*.e2e.test.*",
      "**/*.live.test.*",
      "**/*.live.e2e.test.*",
      "**/*.real.test.*",
      "**/*.real.e2e.test.*",
    ],
    // Skip tests gracefully when native dependencies are missing
    passWithNoTests: true,
    // Give more time for tests that load heavy dependencies
    testTimeout: 30000,
  },
});
