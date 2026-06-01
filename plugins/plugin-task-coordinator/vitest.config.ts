import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "src/__tests__/**/*.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
