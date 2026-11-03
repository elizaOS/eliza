import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "import", "module", "browser", "default"],
  },
  test: {
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
