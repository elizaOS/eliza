/**
 * Vitest config for the plugin's unit suite. Loads the shared
 * `core-test-mock.ts` setup file and excludes `*.real.test.ts`, which boot a
 * real PGLite runtime and run instead under `vitest.real-runtime.config.ts`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "test/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    // `*.real.test.ts` boot a real PGLite runtime and need the workspace
    // source aliases from vitest.real-runtime.config.ts — run via `test:real-runtime`.
    exclude: ["**/node_modules/**", "dist/**", "**/*.real.test.ts"],
    setupFiles: ["./__tests__/core-test-mock.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
