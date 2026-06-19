import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/**",
      "**/*.e2e.test.*",
      "**/*.live.test.*",
      "**/*.real.test.*",
    ],
  },
});
