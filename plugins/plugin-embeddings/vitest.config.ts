/** Adapter integration checks; live and keyless-runtime suites have dedicated configs. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fsModuleCache: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
