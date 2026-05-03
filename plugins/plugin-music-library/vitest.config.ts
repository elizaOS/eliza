import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/__tests__/core-test-mock.ts"],
  },
});
