import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ["./src/__tests__/unit/core-test-mock.ts"],
    exclude: ["**/node_modules/**"],
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "**/node_modules/**",
        "**/tests/**",
        "**/e2e/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/coverage/**",
        "**/dist/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
