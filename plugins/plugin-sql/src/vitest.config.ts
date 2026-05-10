import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/__tests__/e2e/**",
      "**/*.live.test.ts",
      "**/*.real.test.ts",
      "**/*.real.e2e.test.ts",
      "**/*.e2e.test.ts",
    ],
    // Increase timeout for hooks that need to close database connections
    hookTimeout: 60000,
    // Increase test timeout for database operations (migration tests are slow)
    testTimeout: 120000,
    // Use forks pool for better test isolation
    pool: "forks",
    // Vitest 4.x moved pool options to top level
    isolate: true,
    fileParallelism: false,
    // Allow retries for flaky database tests
    retry: 1,
    // Reduce log noise
    reporters: process.env.CI ? ["verbose"] : ["default"],
    // Increase global test suite timeout
    testNamePattern: undefined,
  },
});
