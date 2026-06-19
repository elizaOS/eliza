import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ["./__tests__/core-test-mock.ts"],
    sequence: {
      concurrent: false,
    },
  },
});
