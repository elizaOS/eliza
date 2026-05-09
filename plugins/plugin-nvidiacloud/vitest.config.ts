import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    passWithNoTests: true,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
