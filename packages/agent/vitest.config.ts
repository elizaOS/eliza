import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*-real.test.{ts,tsx}",
    ],
  },
});
