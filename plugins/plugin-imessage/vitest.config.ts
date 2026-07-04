/** Vitest config for the iMessage plugin; loads the `@elizaos/core` mock in `__tests__/core-test-mock.ts` as a setup file. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
    setupFiles: ["./__tests__/core-test-mock.ts"],
  },
});
