/** Vitest config for the LINE connector; runs the src + __tests__ unit suites and excludes live/e2e tests. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
  },
});
