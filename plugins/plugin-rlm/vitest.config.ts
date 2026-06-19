import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
