/**
 * Vitest config for this plugin's unit tests: the web-fallback rejection tests
 * run under jsdom (opted in per-file via a `@vitest-environment` directive);
 * the real isolation behaviour is covered by the native instrumented tests
 * (Android connectedAndroidTest, iOS XCTest), not here.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
